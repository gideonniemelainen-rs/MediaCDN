// Upload server for the local pipeline. Endpoints (all under /api/pipeline):
//   GET  /health            liveness, and whether the database answers
//   POST /auth/login        {username, password} -> session cookie (and token); /auth/logout, /auth/password
//   GET  /auth/me           the signed-in user
//   POST /uploads           raw video body, X-Filename header; starts a job
//   GET  /jobs, /jobs/:id   job summaries, one job snapshot
//   GET  /jobs/:id/events   server-sent events: the current snapshot, then every change
// With `auth` given (always, outside tests) everything except /health and the login route needs a session.
// It runs ffmpeg on whatever it is sent, so it only answers to localhost and to the dev server's
// origin, sends no CORS headers (a cross-site page cannot reach it) and binds to loopback.
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MIN_PASSWORD, clearCookie, createRateLimiter, newToken, sessionCookie, tokenFrom, verifyPassword } from './auth.mjs'
import { createJobManager, isTerminal, publicJob } from './jobs.mjs'
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

const DUMMY_HASH = `scrypt$16384$8$1$${'A'.repeat(22)}==$${'A'.repeat(43)}=`
const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, mustChangePassword: u.mustChangePassword })

async function readJson(req, max = 4096) {
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
export async function createPipelineServer({ work, origin, profile, steps, auth, allowedOrigins = DEFAULT_ORIGINS, now = Date.now }) {
  const limiter = auth?.limiter ?? createRateLimiter()
  const manager = await createJobManager({ work, steps, now })
  const maxBytes = profile.limits.maxFileBytes
  const uploads = join(work, 'uploads')

  async function handleUpload(req, res) {
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
    const meta = { uploadId, name, bytes, sha256, outputId, source: file }
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

  function handleEvents(req, res, job) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const send = (j) => {
      res.write(`data: ${JSON.stringify(publicJob(j))}\n\n`)
      if (isTerminal(j)) {
        res.write('event: done\ndata: {}\n\n')
        cleanup()
        res.end()
      }
    }
    const unsubscribe = manager.subscribe(job.id, send)
    const ping = setInterval(() => res.write(': ping\n\n'), 15000)
    const cleanup = () => {
      clearInterval(ping)
      unsubscribe()
    }
    req.on('close', cleanup)
    send(manager.get(job.id))
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

      if (req.method === 'POST' && path === '/uploads') return await handleUpload(req, res)
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })

      // The graph the UI draws while a file is still uploading, before any job exists.
      if (path === '/stages') return json(res, 200, { stages: STAGES })
      if (path === '/jobs') return json(res, 200, { jobs: manager.list() })
      const m = /^\/jobs\/([0-9a-f]{8})(\/events)?$/.exec(path)
      const job = m && manager.get(m[1])
      if (!job) return json(res, 404, { error: 'not found' })
      if (m[2]) return handleEvents(req, res, job)
      return json(res, 200, publicJob(job))
    } catch (e) {
      if (!res.headersSent) json(res, e.status ?? 500, { error: e.message })
      else res.end()
    }
  })

  return { server, manager }
}
