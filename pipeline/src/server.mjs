// Upload server for the local pipeline. Endpoints (all under /api/pipeline):
//   GET  /health            liveness, and whether the database answers
//   POST /auth/login        {username, password} -> session cookie (and token); /auth/logout, /auth/password
//   GET  /auth/me           the signed-in user
//   POST /uploads           raw video body, X-Filename header; starts a job
//   GET  /jobs, /jobs/:id   job summaries, one job snapshot (your own; an admin sees all)
//   GET  /jobs/:id/events   server-sent events: the current snapshot, then every change
//   GET  /uploads, /uploads/:id   upload history from the database (needs `history`)
//   GET  /settings          the settings overrides, their revisions and the highest revision (no session needed)
//   PUT  /settings/:group, DELETE /settings/:group/:field   change settings (admin only; If-Match: <group revision>)
//   GET  /workflows         the workflows (admin only, as is everything about runs)
//   POST /workflows/:id/runs   start a run with validated parameters; a real S3 run needs `confirm`, a dry run's id (409 otherwise)
//   GET  /runs, /runs/:id, /runs/:id/events, /runs/:id/files/:name.json   run history, one run, its live events, what it produced
//   POST /benchmarks        save a benchmark run; GET /benchmarks, /benchmarks/:id,
//                           /benchmarks/:id/artifacts/:kind; DELETE /benchmarks/:id (all yours; admin: all)
// With `auth` given (always, outside tests) everything except /health, GET /settings and the login route needs a session.
// It runs ffmpeg on whatever it is sent, so it only answers to localhost and to the dev server's
// origin, sends no CORS headers (a cross-site page cannot reach it) and binds to loopback.
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isGroupName } from '../../shared/src/settings.ts'
import { WORKFLOWS, WORKFLOW_IDS, describeWorkflow, isWorkflowId, validateParams } from '../../shared/src/workflows.ts'
import { MIN_PASSWORD, clearCookie, createRateLimiter, newToken, sessionCookie, tokenFrom, verifyPassword } from './auth.mjs'
import { parseRun } from './benchmarks.mjs'
import { createJobManager, isTerminal, publicJob } from './jobs.mjs'
import { createQueue } from './queue.mjs'
import { createRunManager, publicRun } from './runs.mjs'
import { slugify } from './job.mjs'
import { STAGES } from './stages.mjs'
import { outputIdFor } from './steps.mjs'

const PREFIX = '/api/pipeline'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
export const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

export const hostAllowed = (host) => LOCAL_HOSTS.has(String(host ?? '').replace(/:\d+$/, ''))
export const originAllowed = (origin, allowed) => origin === undefined || allowed.includes(origin)

/** Extension to keep on the stored file: short, alphanumeric, else none. ffprobe sniffs the content anyway. */
export const safeExt = (name) => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name)
  return m ? `.${m[1].toLowerCase()}` : ''
}

/** The client-supplied filename, reduced to its last path segment. Used for display and for the slug. */
export function decodeName(header) {
  let name
  try {
    name = decodeURIComponent(String(header ?? ''))
  } catch {
    return 'upload'
  }
  return name.split(/[\\/]/).pop().slice(0, 200) || 'upload'
}

/** A saved run carries its telemetry events, so its body is far larger than a login. */
const BENCHMARK_BODY_MAX = 10_000_000
const DUMMY_HASH = `scrypt$16384$8$1$${'A'.repeat(22)}==$${'A'.repeat(43)}=`
const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, mustChangePassword: u.mustChangePassword })

async function readJson(req, max = 4096) {
  req.setEncoding('utf8')
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > max) throw Object.assign(new Error('body too large'), { status: 413 })
  }
  try {
    const v = JSON.parse(body || '{}')
    if (v && typeof v === 'object') return v
  } catch {}
  throw Object.assign(new Error('expected a JSON object'), { status: 400 })
}

/**
 * `auth` is `{ users, sessions, limiter?, dbStatus? }` (repos from src/db). Without it the server is open,
 * which only the unit tests that predate auth rely on.
 */
/** Whether `user` may see `job`. Without auth everything is visible; jobs from before accounts have no owner and are the admin's. */
export const canSee = (user, job) => !user || user.role === 'admin' || job.meta.userId === user.id

/** The revision in an `If-Match` header (`7` or `"7"`), undefined when there is none, NaN when it is not a revision. */
export function ifMatchRevision(header) {
  if (header === undefined) return undefined
  const m = /^\s*(?:"(\d{1,15})"|(\d{1,15}))\s*$/.exec(header)
  return m ? Number(m[1] ?? m[2]) : NaN
}

/**
 * `history` is `{ uploads, benchmarks }` (the repos from src/db). With it, every job state change is
 * recorded, and jobs already on disk are recorded once at startup.
 */
export async function createPipelineServer({ work, origin, profile, steps, auth, history, settings, workflows, s3Bucket, allowedOrigins = DEFAULT_ORIGINS, now = Date.now }) {
  const limiter = auth?.limiter ?? createRateLimiter()
  // One queue for uploads and workflow runs: ffmpeg is heavy and a benchmark measures the network, so they take turns.
  const queue = createQueue()
  const manager = await createJobManager({ work, steps, now, queue, onChange: history && ((job) => history.uploads.upsert(job)) })
  const runs = workflows && (await createRunManager({ work, workflows, queue, now, onChange: history?.runs && ((job) => history.runs.upsert(job)) }))
  if (history) {
    for (const job of manager.all()) {
      await history.uploads.upsert(job).catch((e) => console.error(`history: could not record job ${job.id}: ${e.message}`))
    }
    if (history.runs && runs) {
      for (const job of runs.all()) {
        await history.runs.upsert(job).catch((e) => console.error(`history: could not record run ${job.id}: ${e.message}`))
      }
    }
  }
  const maxBytes = profile.limits.maxFileBytes
  const uploads = join(work, 'uploads')

  /** `settings` is the repo from src/db/settings.mjs. Reading is open; changing needs an admin whenever there is auth. */
  async function handleSettings(req, res, path, user) {
    if (path === '/settings') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      return json(res, 200, await settings.all())
    }
    if (req.method !== 'PUT' && req.method !== 'DELETE') return json(res, 405, { error: 'method not allowed' })
    if (auth && user?.role !== 'admin') return json(res, 403, { error: 'admin only' })
    const m = /^\/settings\/([a-z]+)(?:\/([A-Za-z0-9._-]+))?$/.exec(path)
    if (!m || !isGroupName(m[1]) || (req.method === 'PUT') !== (m[2] === undefined)) return json(res, 404, { error: 'not found' })
    const ifRevision = ifMatchRevision(req.headers['if-match'])
    if (Number.isNaN(ifRevision)) return json(res, 400, { error: 'If-Match must be the group revision, a whole number' })
    const opts = { userId: user?.id ?? null, ...(ifRevision !== undefined && { ifRevision }) }
    try {
      const stored = req.method === 'PUT' ? await settings.set(m[1], await readJson(req, 16384), opts) : await settings.unset(m[1], m[2], opts)
      res.setHeader('ETag', `"${stored.revision}"`)
      return json(res, 200, { group: m[1], ...stored })
    } catch (e) {
      if (e.errors) return json(res, e.status ?? 400, { error: e.message, errors: e.errors })
      throw e
    }
  }

  async function handleUpload(req, res, user) {
    const length = Number(req.headers['content-length'])
    if (!Number.isFinite(length) || length <= 0) return json(res, 411, { error: 'Content-Length required' })
    if (length > maxBytes) return json(res, 413, { error: `file is over the ${maxBytes} byte limit` })

    const name = decodeName(req.headers['x-filename'])
    const uploadId = randomBytes(4).toString('hex')
    const dir = join(uploads, uploadId)
    const file = join(dir, `source${safeExt(name)}`)
    await mkdir(dir, { recursive: true })

    const startedAt = now()
    const hash = createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length
        if (bytes > length) return cb(new Error('body longer than Content-Length'))
        hash.update(chunk)
        cb(null, chunk)
      },
    })
    try {
      await pipeline(req, meter, createWriteStream(`${file}.part`))
      if (bytes !== length) throw new Error('upload ended early')
    } catch (e) {
      await rm(dir, { recursive: true, force: true })
      if (!res.destroyed) json(res, 400, { error: e.message })
      return
    }
    await rename(`${file}.part`, file)

    const endedAt = now()
    const sha256 = hash.digest('hex')
    const outputId = await outputIdFor(origin, slugify(name), sha256)
    const seconds = Math.max((endedAt - startedAt) / 1000, 0.001)
    const meta = { uploadId, name, bytes, sha256, outputId, source: file, ...(user ? { userId: user.id } : {}) }
    manager.create({
      id: uploadId,
      meta,
      upload: {
        startedAt,
        endedAt,
        summary: `${(bytes / 1e6).toFixed(1)} MB received`,
        result: { name, bytes, sha256, mbPerSecond: Number((bytes / 1e6 / seconds).toFixed(1)) },
      },
    })
    json(res, 202, { id: uploadId })
  }

  async function handleLogin(req, res) {
    const { username, password, bearer } = await readJson(req)
    if (typeof username !== 'string' || typeof password !== 'string') return json(res, 400, { error: 'username and password required' })
    const key = `${req.socket.remoteAddress}|${username.toLowerCase()}`
    if (limiter.blocked(key)) return json(res, 429, { error: 'too many attempts, try again in a minute' })
    const user = await auth.users.findByName(username)
    // Verify against a dummy hash for an unknown user, so timing does not reveal which names exist.
    const ok = (await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH)) && !!user
    if (!ok) {
      limiter.fail(key)
      return json(res, 401, { error: 'wrong username or password' })
    }
    limiter.reset(key)
    const token = newToken()
    await auth.sessions.create(user.id, token, bearer ? 'bearer' : 'cookie')
    if (!bearer) res.setHeader('Set-Cookie', sessionCookie(token))
    json(res, 200, { user: publicUser(user), token })
  }

  async function handlePassword(req, res, user, token) {
    const { current, next } = await readJson(req)
    if (typeof current !== 'string' || typeof next !== 'string') return json(res, 400, { error: 'current and next required' })
    if (!(await verifyPassword(current, user.passwordHash))) return json(res, 401, { error: 'current password is wrong' })
    if (next.length < MIN_PASSWORD) return json(res, 400, { error: `password must be at least ${MIN_PASSWORD} characters` })
    if (next === 'admin' || next === user.username) return json(res, 400, { error: 'choose a different password' })
    await auth.users.setPassword(user.id, next)
    await auth.sessions.destroyOthers(user.id, token)
    json(res, 200, { user: { ...publicUser(user), mustChangePassword: false } })
  }

  async function handleHistory(res, path, url, user) {
    if (!history) return json(res, 404, { error: 'not found' })
    if (path === '/uploads') {
      return json(res, 200, await history.uploads.list(user, { before: url.searchParams.get('before'), limit: url.searchParams.get('limit') }))
    }
    const m = /^\/uploads\/([0-9a-f]{8})$/.exec(path)
    const upload = m && (await history.uploads.get(user, m[1]))
    return upload ? json(res, 200, upload) : json(res, 404, { error: 'not found' })
  }

  async function handleBenchmarks(req, res, path, url, user) {
    const repo = history?.benchmarks
    if (!repo || !user) return json(res, 404, { error: 'not found' })
    const notFound = () => json(res, 404, { error: 'not found' })

    if (path === '/benchmarks') {
      if (req.method === 'GET') {
        return json(res, 200, await repo.list(user, { before: url.searchParams.get('before'), limit: url.searchParams.get('limit') }))
      }
      if (req.method === 'POST') {
        const run = parseRun(await readJson(req, BENCHMARK_BODY_MAX))
        return json(res, 201, { id: await repo.create(user.id, run) })
      }
      return json(res, 405, { error: 'method not allowed' })
    }
    const m = /^\/benchmarks\/([0-9a-f-]{36})(?:\/artifacts\/([a-z-]{1,40}))?$/.exec(path)
    if (!m) return notFound()
    if (m[2]) {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const blob = await repo.getArtifact(user, m[1], m[2])
      return blob ? json(res, 200, { schemaVersion: blob.schemaVersion, ...blob.json }) : notFound()
    }
    if (req.method === 'GET') {
      const run = await repo.get(user, m[1])
      return run ? json(res, 200, run) : notFound()
    }
    if (req.method === 'DELETE') return (await repo.remove(user, m[1])) ? json(res, 200, { ok: true }) : notFound()
    return json(res, 405, { error: 'method not allowed' })
  }

  function handleEvents(req, res, job, mgr = manager, view = publicJob) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const send = (j) => {
      res.write(`data: ${JSON.stringify(view(j))}\n\n`)
      if (isTerminal(j)) {
        res.write('event: done\ndata: {}\n\n')
        cleanup()
        res.end()
      }
    }
    const unsubscribe = mgr.subscribe(job.id, send)
    const ping = setInterval(() => res.write(': ping\n\n'), 15000)
    const cleanup = () => {
      clearInterval(ping)
      unsubscribe()
    }
    req.on('close', cleanup)
    send(mgr.get(job.id))
  }

  /**
   * Workflows and runs. Running a task on this machine is at least as sensitive as changing settings, so all of it is admin
   * only (whenever there is auth). A run is another person's business only if you are an admin, so there is no per-run owner check.
   */
  async function handleWorkflows(req, res, path, url, user) {
    if (!runs) return json(res, 404, { error: 'not found' })
    if (auth && user?.role !== 'admin') return json(res, 403, { error: 'admin only' })
    const notFound = () => json(res, 404, { error: 'not found' })
    const wrongMethod = () => json(res, 405, { error: 'method not allowed' })

    if (path === '/workflows') {
      if (req.method !== 'GET') return wrongMethod()
      const list = WORKFLOW_IDS.map((id) => describeWorkflow(WORKFLOWS[id], Boolean(workflows[id])))
      return json(res, 200, { workflows: list, defaults: { bucket: s3Bucket ?? null } })
    }
    let m = /^\/workflows\/([a-z0-9-]{1,40})\/runs$/.exec(path)
    if (m) {
      if (req.method !== 'POST') return wrongMethod()
      if (!isWorkflowId(m[1])) return notFound()
      const checked = validateParams(m[1], await readJson(req, 16384), s3Bucket ? { bucket: s3Bucket } : {})
      if (!checked.ok) return json(res, 400, { error: 'invalid parameters', errors: checked.errors })
      try {
        const job = runs.start({ workflow: m[1], params: checked.params, userId: user?.id ?? null })
        return json(res, 201, publicRun(job))
      } catch (e) {
        if (e.status) return json(res, e.status, { error: e.message })
        throw e
      }
    }
    if (path === '/runs') {
      if (req.method !== 'GET') return wrongMethod()
      if (history?.runs) {
        const page = await history.runs.list(user ?? { role: 'admin' }, { before: url.searchParams.get('before'), limit: url.searchParams.get('limit'), workflow: url.searchParams.get('workflow') ?? undefined })
        return json(res, 200, page)
      }
      return json(res, 200, { runs: runs.list(), next: null })
    }
    m = /^\/runs\/([0-9a-f]{8})(?:\/(events)|\/files\/([a-z0-9-]{1,40}\.json))?$/.exec(path)
    const run = m && runs.get(m[1])
    if (!run) return notFound()
    if (req.method !== 'GET') return wrongMethod()
    if (m[2]) return handleEvents(req, res, run, runs, publicRun)
    if (m[3]) {
      // Only what a run itself wrote into its own directory, by a name that cannot leave it.
      const text = await readFile(join(work, 'runs', run.id, m[3]), 'utf8').catch(() => null)
      if (text === null) return notFound()
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(text)
    }
    return json(res, 200, publicRun(run))
  }

  const server = createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host)) return json(res, 403, { error: 'host not allowed' })
      if (!originAllowed(req.headers.origin, allowedOrigins)) return json(res, 403, { error: 'origin not allowed' })
      const url = new URL(req.url, 'http://localhost')
      if (!url.pathname.startsWith(PREFIX)) return json(res, 404, { error: 'not found' })
      const path = url.pathname.slice(PREFIX.length) || '/'

      if (path === '/health' && req.method === 'GET') {
        const db = auth?.dbStatus ? await auth.dbStatus() : null
        return json(res, 200, { ok: true, ...(auth ? { db: db ?? 'ok' } : {}) })
      }
      if (auth && path === '/auth/login' && req.method === 'POST') return await handleLogin(req, res)
      // Settings are readable signed out: the Player needs the delivery config before anyone logs in, and none of it is secret.
      if (settings && path === '/settings' && req.method === 'GET') return await handleSettings(req, res, path, undefined)

      let user, token
      if (auth) {
        token = tokenFrom(req.headers)
        const userId = token && (await auth.sessions.touch(token))
        user = userId && (await auth.users.findById(userId))
        if (!user) {
          if (token && req.headers.cookie) res.setHeader('Set-Cookie', clearCookie())
          return json(res, 401, { error: 'sign in required' })
        }
        if (path === '/auth/me' && req.method === 'GET') return json(res, 200, { user: publicUser(user) })
        if (path === '/auth/logout' && req.method === 'POST') {
          await auth.sessions.destroy(token)
          res.setHeader('Set-Cookie', clearCookie())
          return json(res, 200, { ok: true })
        }
        if (path === '/auth/password' && req.method === 'POST') return await handlePassword(req, res, user, token)
      }

      if (settings && (path === '/settings' || path.startsWith('/settings/'))) return await handleSettings(req, res, path, user)
      if (path === '/workflows' || path.startsWith('/workflows/') || path === '/runs' || path.startsWith('/runs/')) return await handleWorkflows(req, res, path, url, user)
      if (path === '/benchmarks' || path.startsWith('/benchmarks/')) return await handleBenchmarks(req, res, path, url, user)
      if (req.method === 'POST' && path === '/uploads') return await handleUpload(req, res, user)
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })

      // The graph the UI draws while a file is still uploading, before any job exists.
      if (path === '/stages') return json(res, 200, { stages: STAGES })
      if (path === '/jobs') return json(res, 200, { jobs: manager.list((job) => canSee(user, job)) })
      if (path === '/uploads' || path.startsWith('/uploads/')) return await handleHistory(res, path, url, user)
      const m = /^\/jobs\/([0-9a-f]{8})(\/events)?$/.exec(path)
      const job = m && manager.get(m[1])
      // Someone else's job is reported as missing, not forbidden, so ids cannot be probed.
      if (!job || !canSee(user, job)) return json(res, 404, { error: 'not found' })
      if (m[2]) return handleEvents(req, res, job)
      return json(res, 200, publicJob(job))
    } catch (e) {
      if (!res.headersSent) json(res, e.status ?? 500, { error: e.message })
      else res.end()
    }
  })

  return { server, manager, runs }
}
