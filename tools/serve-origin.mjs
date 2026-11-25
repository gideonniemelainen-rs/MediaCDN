#!/usr/bin/env node
// Local origin for packaged media: static files from origin/ with CORS and byte ranges, plus a
// simulated live stream at /live/<slug>/ built from the packaged HLS by tools/live.mjs.
// File names and the index document come from shared/src/title-layout.ts.
// Usage: node tools/serve-origin.mjs [port]   (default 8788)
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DASH_MANIFEST, buildIndex, mediaPlaylist, mediaPlaylistRep, parseLivePath, parseLiveSegment, parseMediaPlaylist } from '../shared/src/title-layout.ts'
import { buildLivePlaylist, liveSegmentFile } from './live.mjs'
import { createOriginSettings } from './origin-settings.mjs'

const ROOT = fileURLToPath(new URL('../origin/', import.meta.url))
const PORT = Number(process.argv[2] ?? 8788)
const EPOCH = Date.now() // every live stream "started" when the server did
// liveEnabled and liveWindow come from the settings (the pipeline API); without it the defaults apply.
const settings = createOriginSettings({
  url: process.env.PIPELINE_URL ?? 'http://127.0.0.1:8790/api/pipeline',
  warn: (m) => console.warn(`origin: ${m}`),
})

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
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Alt-Svc, Age, X-Cache, Via, Cache-Control, Server',
  // Without this, cross-origin Resource Timing hides the negotiated protocol (nextHopProtocol) and the timings.
  'Timing-Allow-Origin': '*',
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

/** /index.json: titles found under origin/, so the app lists whatever is packaged right now. */
async function localIndex() {
  const dirs = await readdir(ROOT, { withFileTypes: true }).catch(() => [])
  const listing = await Promise.all(
    dirs.filter((d) => d.isDirectory()).map(async (d) => ({ slug: d.name, files: await readdir(join(ROOT, d.name)).catch(() => []) })),
  )
  return buildIndex(listing, { live: (await settings.get()).liveEnabled })
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
  const { liveEnabled, liveWindow } = await settings.get()
  if (!liveEnabled) return send(res, 404, { 'Content-Type': 'text/plain' }, 'simulated live is disabled in the settings')
  const rep = mediaPlaylistRep(file)
  if (rep !== null) {
    const parsed = await vodPlaylist(slug, file)
    if (!parsed) return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found')
    const { text } = buildLivePlaylist(parsed, EPOCH, Date.now(), rep, liveWindow)
    if (!text) return send(res, 404, { 'Content-Type': 'text/plain', 'Retry-After': '2' }, 'live not started yet')
    return send(res, 200, { 'Content-Type': TYPES['.m3u8'], 'Cache-Control': 'no-cache' }, text)
  }
  const seg = parseLiveSegment(file)
  if (seg) {
    const parsed = await vodPlaylist(slug, mediaPlaylist(seg.rep))
    const real = parsed && liveSegmentFile(parsed, file, seg.rep)
    const path = real && safePath(join(slug, real))
    return path ? serveFile(req, res, path) : send(res, 404, { 'Content-Type': 'text/plain' }, 'not found')
  }
  const path = file === DASH_MANIFEST ? null : safePath(join(slug, file)) // no DASH live (see docs)
  return path ? serveFile(req, res, path) : send(res, 404, { 'Content-Type': 'text/plain' }, 'not found')
}

createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, { 'Access-Control-Max-Age': '600' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, {}, 'method not allowed')
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/index.json') {
      return send(res, 200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-cache' }, JSON.stringify(await localIndex()))
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const live = parseLivePath(rel)
    if (live) return await serveLive(req, res, live.slug, live.file)
    const path = safePath(rel)
    if (!path) return send(res, 403, {}, 'forbidden')
    await serveFile(req, res, path)
  } catch (e) {
    console.error(e)
    send(res, 500, {}, 'error')
  }
}).listen(PORT, () => console.log(`origin on http://localhost:${PORT}  (serving ${ROOT})`))
