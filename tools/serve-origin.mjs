#!/usr/bin/env node
// Local origin for packaged media: static files from origin/ with CORS and byte ranges, plus a
// simulated live stream at /live/<slug>/ built from the packaged HLS by tools/live.mjs.
// Usage: node tools/serve-origin.mjs [port]   (default 8788)
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLivePlaylist, liveSegmentFile, parseMediaPlaylist } from './live.mjs'

const ROOT = fileURLToPath(new URL('../origin/', import.meta.url))
const PORT = Number(process.argv[2] ?? 8788)
const EPOCH = Date.now() // every live stream "started" when the server did

const TYPES = {
  '.mpd': 'application/dash+xml',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Origin, Accept',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
}

function safePath(rel) {
  const p = normalize(join(ROOT, rel))
  return p.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) ? p : null
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...CORS, ...headers })
  res.end(body)
}

async function serveFile(req, res, file, extra = {}) {
  const st = await stat(file).catch(() => null)
  if (!st?.isFile()) return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found')
  const type = TYPES[extname(file)] ?? 'application/octet-stream'
  const cache = file.endsWith('.m3u8') || file.endsWith('.mpd') ? 'no-cache' : 'public, max-age=3600'
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache, ...extra }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (!range) {
    res.writeHead(200, { ...CORS, ...base, 'Content-Length': st.size })
    return req.method === 'HEAD' ? res.end() : createReadStream(file).pipe(res)
  }
  let start = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1])
  let end = range[1] === '' || range[2] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1)
  if (start > end || start >= st.size) {
    return send(res, 416, { ...base, 'Content-Range': `bytes */${st.size}` })
  }
  res.writeHead(206, {
    ...CORS,
    ...base,
    'Content-Range': `bytes ${start}-${end}/${st.size}`,
    'Content-Length': end - start + 1,
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file, { start, end }).pipe(res)
}

const playlistCache = new Map()
async function vodPlaylist(slug, file) {
  const path = safePath(join(slug, file))
  if (!path) return null
  const mtime = (await stat(path).catch(() => null))?.mtimeMs
  if (mtime === undefined) return null
  const hit = playlistCache.get(path)
  if (hit?.mtime === mtime) return hit.parsed
  const parsed = parseMediaPlaylist(await readFile(path, 'utf8'))
  playlistCache.set(path, { mtime, parsed })
  return parsed
}

/** /live/<slug>/<file>: generated media playlists and mapped segments; everything else is passed through. */
async function serveLive(req, res, slug, file) {
  const m = /^media_(\d+)\.m3u8$/.exec(file)
  if (m) {
    const parsed = await vodPlaylist(slug, file)
    if (!parsed) return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found')
    const { text } = buildLivePlaylist(parsed, EPOCH, Date.now(), `live${m[1]}`)
    if (!text) return send(res, 404, { 'Content-Type': 'text/plain', 'Retry-After': '2' }, 'live not started yet')
    return send(res, 200, { 'Content-Type': TYPES['.m3u8'], 'Cache-Control': 'no-cache' }, text)
  }
  const seg = /^live(\d+)-\d+\.m4s$/.exec(file)
  if (seg) {
    const parsed = await vodPlaylist(slug, `media_${seg[1]}.m3u8`)
    const real = parsed && liveSegmentFile(parsed, file, `live${seg[1]}`)
    const path = real && safePath(join(slug, real))
    return path ? serveFile(req, res, path) : send(res, 404, { 'Content-Type': 'text/plain' }, 'not found')
  }
  const path = file === 'manifest.mpd' ? null : safePath(join(slug, file)) // no DASH live (see docs)
  return path ? serveFile(req, res, path) : send(res, 404, { 'Content-Type': 'text/plain' }, 'not found')
}

createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, { 'Access-Control-Max-Age': '600' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, {}, 'method not allowed')
    const url = new URL(req.url, 'http://x')
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const live = /^live\/([\w-]+)\/([\w.-]+)$/.exec(rel)
    if (live) return await serveLive(req, res, live[1], live[2])
    const path = safePath(rel)
    if (!path) return send(res, 403, {}, 'forbidden')
    await serveFile(req, res, path)
  } catch (e) {
    console.error(e)
    send(res, 500, {}, 'error')
  }
}).listen(PORT, () => console.log(`origin on http://localhost:${PORT}  (serving ${ROOT})`))
