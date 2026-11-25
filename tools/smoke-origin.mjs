#!/usr/bin/env node
// Smoke test for tools/serve-origin.mjs against a packaged title in origin/.
// Starts its own server on a spare port. Usage: node tools/smoke-origin.mjs [slug]  (default: selftest)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { DASH_MANIFEST, HLS_MASTER, chunk, initSegment, liveSegment, mediaPlaylistRep } from '../shared/src/title-layout.ts'

const slug = process.argv[2] ?? 'selftest'
const PORT = 8799
const B = `http://localhost:${PORT}`
const server = spawn(process.execPath, [new URL('./serve-origin.mjs', import.meta.url).pathname, String(PORT)], {
  stdio: 'ignore',
})

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok    ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`)
  }
}

try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${B}/`).then(() => true, () => false)) break
    await sleep(100)
  }
  const master = await readFile(new URL(`../origin/${slug}/${HLS_MASTER}`, import.meta.url), 'utf8')
  const video = master.split(/\r?\n/).find((l) => mediaPlaylistRep(l) !== null)
  const n = mediaPlaylistRep(video)

  await check('static playlist: CORS, type, no-cache', async () => {
    const r = await fetch(`${B}/${slug}/${HLS_MASTER}`, { headers: { Origin: 'http://localhost:5173' } })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('access-control-allow-origin'), '*')
    assert.match(r.headers.get('content-type'), /mpegurl/)
    assert.equal(r.headers.get('cache-control'), 'no-cache')
  })

  await check('Timing-Allow-Origin and the diagnostic headers are exposed', async () => {
    const r = await fetch(`${B}/${slug}/${HLS_MASTER}`, { headers: { Origin: 'http://localhost:5173' } })
    assert.equal(r.headers.get('timing-allow-origin'), '*')
    const exposed = r.headers.get('access-control-expose-headers').toLowerCase()
    for (const h of ['content-range', 'alt-svc', 'age', 'x-cache', 'via']) assert.ok(exposed.includes(h), `${h} not exposed`)
  })

  await check('segment: byte range gives 206 and Content-Range', async () => {
    const r = await fetch(`${B}/${slug}/${chunk(n, 1)}`, { headers: { Range: 'bytes=0-99' } })
    assert.equal(r.status, 206)
    assert.match(r.headers.get('content-range'), /^bytes 0-99\/\d+$/)
    assert.equal((await r.arrayBuffer()).byteLength, 100)
  })

  await check('path traversal is refused', async () => {
    const r = await fetch(`${B}/..%2fpackage.json`)
    assert.ok([403, 404].includes(r.status), `got ${r.status}`)
  })

  await check('CORS preflight', async () => {
    const r = await fetch(`${B}/${slug}/${HLS_MASTER}`, { method: 'OPTIONS' })
    assert.equal(r.status, 204)
  })

  // The live clock starts when the server does; the first segment appears after one segment duration.
  await sleep(4500)
  await check('live playlist: window, init, PDT, no VOD tags', async () => {
    const r = await fetch(`${B}/live/${slug}/${video}`)
    assert.equal(r.status, 200, 'playlist')
    const t = await r.text()
    assert.match(t, /#EXT-X-MEDIA-SEQUENCE:0\n/)
    assert.match(t, /#EXT-X-MAP:URI="init-\d+\.m4s"/)
    assert.match(t, /#EXT-X-PROGRAM-DATE-TIME:/)
    assert.ok(!t.includes('#EXT-X-ENDLIST'))
    assert.ok(t.includes(liveSegment(n, 0)), 'first live segment listed')
  })

  await check('live segment and init resolve to real files', async () => {
    const seg = await fetch(`${B}/live/${slug}/${liveSegment(n, 0)}`)
    assert.equal(seg.status, 200)
    assert.ok((await seg.arrayBuffer()).byteLength > 1000)
    const init = await fetch(`${B}/live/${slug}/${initSegment(n)}`)
    assert.equal(init.status, 200)
  })

  await check('live master is passed through unchanged', async () => {
    const live = await (await fetch(`${B}/live/${slug}/${HLS_MASTER}`)).text()
    assert.equal(live, master)
  })

  await check('live DASH is not offered', async () => {
    assert.equal((await fetch(`${B}/live/${slug}/${DASH_MANIFEST}`)).status, 404)
  })
} finally {
  server.kill()
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed ? 1 : 0
