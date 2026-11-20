// Upload server for the local pipeline. Endpoints (all under /api/pipeline):
//   GET  /health            liveness
//   POST /uploads           raw video body, X-Filename header; starts a job
//   GET  /jobs, /jobs/:id   job summaries, one job snapshot
//   GET  /jobs/:id/events   server-sent events: the current snapshot, then every change
// It runs ffmpeg on whatever it is sent, so it only answers to localhost and to the dev server's
// origin, sends no CORS headers (a cross-site page cannot reach it) and binds to loopback.
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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

export async function createPipelineServer({ work, origin, profile, steps, allowedOrigins = DEFAULT_ORIGINS, now = Date.now }) {
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

      if (req.method === 'POST' && path === '/uploads') return await handleUpload(req, res)
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })

      if (path === '/health') return json(res, 200, { ok: true })
      // The graph the UI draws while a file is still uploading, before any job exists.
      if (path === '/stages') return json(res, 200, { stages: STAGES })
      if (path === '/jobs') return json(res, 200, { jobs: manager.list() })
      const m = /^\/jobs\/([0-9a-f]{8})(\/events)?$/.exec(path)
      const job = m && manager.get(m[1])
      if (!job) return json(res, 404, { error: 'not found' })
      if (m[2]) return handleEvents(req, res, job)
      return json(res, 200, publicJob(job))
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message })
      else res.end()
    }
  })

  return { server, manager }
}
