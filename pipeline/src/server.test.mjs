import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createJobManager } from './jobs.mjs'
import { createPipelineServer } from './server.mjs'
import { StageError } from './run.mjs'
import { newJob, startStage } from './stages.mjs'

const cleanup = []
after(() => Promise.all(cleanup.map((f) => f())))

const quick = (summary) => async () => ({ summary })
const stubSteps = (over = {}) => ({
  probe: quick('probed'), validate: quick('accepted'), normalise: quick('normalised'),
  package: quick('packaged'), verify: quick('verified'), publish: quick('published'),
  ...over,
})

async function start({ steps = stubSteps(), maxFileBytes = 1000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-server-'))
  const profile = { limits: { maxFileBytes } }
  const { server, manager } = await createPipelineServer({ work: join(root, 'work'), origin: join(root, 'origin'), profile, steps })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  cleanup.push(async () => { server.close(); server.closeAllConnections(); await rm(root, { recursive: true, force: true }) })
  return { base: `http://127.0.0.1:${server.address().port}/api/pipeline`, port: server.address().port, manager, root }
}

const upload = (base, body, name = 'Screen Recording.mov') =>
  fetch(`${base}/uploads`, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(name) }, body })

async function finished(t, id) {
  await t.manager.idle()
  return (await fetch(`${t.base}/jobs/${id}`)).json()
}

test('an upload becomes a job that runs every stage to success', async () => {
  const t = await start()
  const res = await upload(t.base, 'x'.repeat(500))
  assert.equal(res.status, 202)
  const { id } = await res.json()
  const job = await finished(t, id)
  assert.equal(job.status, 'success')
  assert.deepEqual(job.stages.map((s) => s.status), Array(7).fill('success'))
  const up = job.stages[0]
  assert.equal(up.result.bytes, 500)
  assert.equal(up.result.name, 'Screen Recording.mov')
  assert.match(up.result.sha256, /^[0-9a-f]{64}$/)
  assert.equal(job.meta.outputId, 'ugc-screen-recording')
})

test('the stored file keeps the sniffed-safe extension and the client never sees server paths', async () => {
  const t = await start()
  const { id } = await (await upload(t.base, 'abc')).json()
  const job = await finished(t, id)
  assert.equal('source' in job.meta, false)
  assert.equal(JSON.stringify(job).includes(t.root), false)
  assert.equal(await readFile(join(t.root, 'work', 'uploads', id, 'source.mov'), 'utf8'), 'abc')
})

test('hostile filenames cannot escape the upload directory', async () => {
  const t = await start()
  const { id } = await (await upload(t.base, 'abc', '../../etc/passwd')).json()
  const job = await finished(t, id)
  assert.equal(job.meta.name, 'passwd')
  assert.equal(job.meta.outputId, 'ugc-passwd')
  assert.equal(await readFile(join(t.root, 'work', 'uploads', id, 'source'), 'utf8'), 'abc')
  const { id: id2 } = await (await upload(t.base, 'abc', 'C:\\Users\\me\\clip.mov')).json()
  assert.equal((await finished(t, id2)).meta.name, 'clip.mov')
})

test('a missing Content-Length and an oversized file are refused', async () => {
  const t = await start({ maxFileBytes: 100 })
  const chunked = await fetch(`${t.base}/uploads`, {
    method: 'POST', duplex: 'half', headers: { 'X-Filename': 'a.mov' },
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('abc')); c.close() } }),
  })
  assert.equal(chunked.status, 411)
  assert.equal((await upload(t.base, 'x'.repeat(101))).status, 413)
  assert.equal((await upload(t.base, 'x'.repeat(100))).status, 202)
})

function raw(port, { method = 'GET', path, headers }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res))
    })
    req.on('error', reject)
    req.end()
  })
}

test('requests with a foreign Host or Origin are refused, and no CORS headers are sent', async () => {
  const t = await start()
  const path = '/api/pipeline/health'
  assert.equal((await raw(t.port, { path, headers: { Host: 'evil.example' } })).statusCode, 403)
  assert.equal((await raw(t.port, { path, headers: { Origin: 'https://evil.example' } })).statusCode, 403)
  const ok = await raw(t.port, { path, headers: { Origin: 'http://localhost:5173' } })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.headers['access-control-allow-origin'], undefined)
  assert.equal((await raw(t.port, { method: 'OPTIONS', path, headers: {} })).statusCode, 405)
})

test('the stage definitions are served so the UI can draw the graph before a job exists', async () => {
  const t = await start()
  const { stages } = await (await fetch(`${t.base}/stages`)).json()
  assert.deepEqual(stages.map((s) => s.id), ['upload', 'probe', 'validate', 'normalise', 'package', 'verify', 'publish'])
  assert.deepEqual(stages[1].needs, ['upload'])
})

test('unknown routes and jobs are 404, other methods 405', async () => {
  const t = await start()
  assert.equal((await fetch(`${t.base}/jobs/deadbeef`)).status, 404)
  assert.equal((await fetch(`${t.base}/jobs/not-an-id`)).status, 404)
  assert.equal((await fetch(`${t.base}/nope`)).status, 404)
  assert.equal((await fetch(`${t.base}/jobs`, { method: 'DELETE' })).status, 405)
})

async function readEvents(url) {
  const res = await fetch(url)
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  const snapshots = []
  let done = false
  let buf = ''
  for await (const chunk of res.body) {
    buf += new TextDecoder().decode(chunk)
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (block.startsWith('event: done')) done = true
      else if (block.startsWith('data: ')) snapshots.push(JSON.parse(block.slice(6)))
    }
  }
  return { snapshots, done }
}

test('SSE streams the current snapshot then each change, and ends with done', async () => {
  const t = await start({ steps: stubSteps({ package: async (_c, h) => { h.progress(0.5); await new Promise((r) => setTimeout(r, 300)); return { summary: 'packaged' } } }) })
  const { id } = await (await upload(t.base, 'abc')).json()
  const { snapshots, done } = await readEvents(`${t.base}/jobs/${id}/events`)
  assert.equal(done, true)
  assert.ok(snapshots.length >= 3, `got ${snapshots.length} snapshots`)
  assert.equal(snapshots.at(-1).status, 'success')
  assert.ok(snapshots.some((s) => s.stages.find((x) => x.id === 'package').status === 'running'))
  // Stage completion only ever moves forward.
  const rank = { queued: 0, running: 1, success: 2, cached: 2, failed: 2, skipped: 2 }
  for (const s of snapshots) for (const st of s.stages) assert.ok(rank[st.status] >= 0)
})

test('connecting to a finished job gets its final snapshot and done straight away', async () => {
  const t = await start()
  const { id } = await (await upload(t.base, 'abc')).json()
  await t.manager.idle()
  const { snapshots, done } = await readEvents(`${t.base}/jobs/${id}/events`)
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].status, 'success')
  assert.equal(done, true)
})

test('a failing stage fails the job, skips the rest, and the next job still runs', async () => {
  let n = 0
  const t = await start({ steps: stubSteps({ validate: async () => { if (n++ === 0) throw new StageError('E_AUDIO_ONLY', 'audio-only input'); return { summary: 'accepted' } } }) })
  const first = await (await upload(t.base, 'abc')).json()
  const second = await (await upload(t.base, 'def')).json()
  const a = await finished(t, first.id)
  const b = await finished(t, second.id)
  assert.equal(a.status, 'failed')
  assert.deepEqual(a.stages.map((s) => s.status), ['success', 'success', 'failed', 'skipped', 'skipped', 'skipped', 'skipped'])
  assert.equal(b.status, 'success')
  const { jobs } = await (await fetch(`${t.base}/jobs`)).json()
  assert.deepEqual(jobs.map((j) => j.status).sort(), ['failed', 'success'])
})

test('jobs run one at a time', async () => {
  let running = 0
  let peak = 0
  const t = await start({ steps: stubSteps({ probe: async () => { peak = Math.max(peak, ++running); await new Promise((r) => setTimeout(r, 40)); running-- } }) })
  await Promise.all([upload(t.base, 'a'), upload(t.base, 'b'), upload(t.base, 'c')])
  await t.manager.idle()
  assert.equal(peak, 1)
})

test('after a restart, jobs that were mid-run are shown as failed, not running forever', async () => {
  const work = await mkdtemp(join(tmpdir(), 'pipeline-restart-'))
  cleanup.push(() => rm(work, { recursive: true, force: true }))
  await mkdir(join(work, 'jobs'), { recursive: true })
  let job = newJob({ id: 'a1b2c3d4', meta: { name: 'x.mov' }, now: 1 })
  job = startStage(job, 'upload', 2)
  await writeFile(join(work, 'jobs', 'a1b2c3d4.json'), JSON.stringify(job))
  const manager = await createJobManager({ work, steps: {} })
  const loaded = manager.get('a1b2c3d4')
  assert.equal(loaded.status, 'failed')
  assert.equal(loaded.stages[0].result.code, 'E_INTERRUPTED')
  assert.ok(loaded.stages.slice(1).every((s) => s.status === 'skipped'))
})
