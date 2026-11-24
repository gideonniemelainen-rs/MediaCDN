// End to end with the real stages: generates the fixtures, uploads them to a real server and
// checks the job graph and what lands in origin/. Skipped when ffmpeg is missing.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildIndex } from '../../tools/index-lib.mjs'
import { createPipelineServer } from './server.mjs'
import { createSteps } from './steps.mjs'

const pipeline = fileURLToPath(new URL('..', import.meta.url))
const has = (cmd) => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0
const skip = has('ffmpeg') && has('ffprobe') ? false : 'ffmpeg/ffprobe not installed'

let root, fx, origin, base, manager, server

before(async () => {
  if (skip) return
  root = await mkdtemp(join(tmpdir(), 'pipeline-e2e-'))
  fx = join(root, 'fx')
  origin = join(root, 'origin')
  execFileSync('bash', [join(pipeline, 'fixtures/generate.sh'), fx], { stdio: 'inherit' })
  const profile = JSON.parse(await readFile(join(pipeline, 'profiles/default.json'), 'utf8'))
  const work = join(root, 'work')
  ;({ server, manager } = await createPipelineServer({ work, origin, profile, steps: createSteps({ profile, work, origin }) }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}/api/pipeline`
})

after(async () => {
  if (skip) return
  server.close()
  server.closeAllConnections()
  await rm(root, { recursive: true, force: true })
})

async function run(file) {
  const body = await readFile(join(fx, file))
  const res = await fetch(`${base}/uploads`, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(file) }, body })
  assert.equal(res.status, 202)
  const { id } = await res.json()
  await manager.idle()
  return (await fetch(`${base}/jobs/${id}`)).json()
}

const stage = (job, id) => job.stages.find((s) => s.id === id)
const states = (job) => job.stages.map((s) => s.status)

test('a clean video flows through every stage and is published', { skip }, async () => {
  const job = await run('clean.mp4')
  assert.equal(job.status, 'success', JSON.stringify(states(job)))
  assert.deepEqual(states(job), Array(8).fill('success'))

  const verify = stage(job, 'verify').result
  assert.equal(verify.ok, true, JSON.stringify(verify.checks.filter((c) => !c.ok)))
  assert.ok(stage(job, 'package').result.rungs.length >= 1)
  assert.equal(stage(job, 'ladder').result.fixed, true, 'the ffmpeg packager keeps its fixed table')

  const files = await readdir(join(origin, 'ugc-clean'))
  for (const f of ['master.m3u8', 'manifest.mpd', 'source.json']) assert.ok(files.includes(f), `${f} missing`)
  assert.deepEqual((await readdir(origin)).filter((n) => n.startsWith('.tmp-')), [], 'staging dir left behind')

  const index = buildIndex(await Promise.all((await readdir(origin)).map(async (slug) => ({ slug, files: await readdir(join(origin, slug)) }))))
  assert.deepEqual(index.titles.map((t) => [t.id, t.protocols]), [['ugc-clean', ['hls', 'dash']]])
})

test('a silent screen recording is packaged, with the problems it had reported along the way', { skip }, async () => {
  const job = await run('screen-silent.mp4')
  assert.equal(job.status, 'success', JSON.stringify(states(job)))
  const codes = stage(job, 'validate').result.warnings.map((w) => w.code)
  assert.ok(codes.includes('W_NO_AUDIO') && codes.includes('W_LOW_FPS'), codes.join())
  assert.deepEqual(stage(job, 'normalise').result.decisions.audio, { synthesised: true })
  assert.ok(stage(job, 'verify').result.checks.find((c) => c.name === 'Audio rendition in master').ok)
  assert.ok(existsSync(join(origin, 'ugc-screen-silent', 'master.m3u8')))
})

test('an audio-only upload is rejected at validate and nothing is published', { skip }, async () => {
  const before = await readdir(origin)
  const job = await run('audio-only.m4a')
  assert.equal(job.status, 'failed')
  assert.deepEqual(states(job), ['success', 'success', 'failed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped'])
  assert.equal(stage(job, 'validate').result.code, 'E_AUDIO_ONLY')
  assert.deepEqual(await readdir(origin), before)
})

test('a truncated upload fails at probe', { skip }, async () => {
  const job = await run('truncated.mp4')
  assert.equal(job.status, 'failed')
  assert.equal(stage(job, 'probe').status, 'failed')
  assert.equal(stage(job, 'probe').result.code, 'E_UNREADABLE')
})

test('uploading the same file again reuses the normalised result and replaces its own title', { skip }, async () => {
  const job = await run('clean.mp4')
  assert.equal(job.status, 'success')
  assert.equal(stage(job, 'normalise').status, 'cached')
  assert.equal(job.meta.outputId, 'ugc-clean')
})
