import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { DASH_MANIFEST, HLS_MASTER, isTitleFile } from '../../../shared/src/title-layout.ts'
import { WORKFLOWS, validateParams } from '../../../shared/src/workflows.ts'
import { createRunManager } from '../runs.mjs'
import { createWorkflows } from './index.mjs'
import { spawnStage } from './spawn.mjs'

const has = (cmd) => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0
const skipFfmpeg = has('ffmpeg') && has('ffprobe') ? false : 'ffmpeg/ffprobe not installed'

let dir
before(() => (dir = mkdtempSync(join(tmpdir(), 'workflows-'))))
after(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const fresh = (name) => mkdtempSync(join(dir, `${name}-${++n}-`))
const put = (root, file, text) => {
  mkdirSync(join(root, file, '..'), { recursive: true })
  writeFileSync(join(root, file), text)
}
const stages = (job) => Object.fromEntries(job.stages.map((s) => [s.id, s.status]))
const logs = (job) => job.stages.flatMap((s) => s.log)

/** A stand-in repository: each script just reports its arguments and the environment it was given. */
function standIn(over = {}) {
  const root = fresh('root')
  const echo = (name) => `console.log(${JSON.stringify(name)} + ' args=' + JSON.stringify(process.argv.slice(2)))
console.log('DATABASE_URL=' + (process.env.DATABASE_URL ?? 'absent') + ' PATH=' + (process.env.PATH ? 'set' : 'absent') + ' EXTRA=' + (process.env.EXTRA ?? '-'))
console.log('3/4 reachable, 2 with usable CORS')`
  for (const f of ['scripts/probe-sources.mjs', 'scripts/make-ads.mjs', 'tools/smoke-origin.mjs']) put(root, f, over[f] ?? echo(f))
  put(root, 'scripts/fetch-sources.mjs', over['scripts/fetch-sources.mjs'] ?? "for (const id of process.argv.slice(2)) console.log((id === 'have-it' ? 'have  ' : 'got   ') + id)")
  put(root, 'media/sources.json', JSON.stringify({ titles: [{ id: 'bbb' }, { id: 'have-it' }, { id: 'sintel' }] }))
  for (const [f, text] of Object.entries(over)) put(root, f, text)
  put(root, 'bench/rates.json', JSON.stringify({ _note: 'n', s3: {}, cdn: {} }))
  return root
}

const mk = async (workflows, work = fresh('w')) => createRunManager({ work, workflows })
async function go(workflows, workflow, input, defaults) {
  const v = validateParams(workflow, input, defaults)
  assert.ok(v.ok, JSON.stringify(v))
  const work = fresh('w')
  const m = await mk(workflows, work)
  const job = m.start({ workflow, params: v.params, userId: 'u' })
  await m.idle()
  return { job: m.get(job.id), m, work }
}

test('every runnable workflow in the registry has an implementation with a step for each of its stages', () => {
  const impl = createWorkflows({ root: standIn() })
  for (const wf of Object.values(WORKFLOWS)) {
    if (wf.kind === 'guide') assert.ok(!(wf.id in impl), `${wf.id} is a guide and must not be runnable`)
    else if (wf.safety === 'safe') {
      assert.ok(impl[wf.id], `${wf.id} is implemented`)
      const steps = impl[wf.id].steps({ params: {}, dryRun: false })
      for (const s of wf.stages) assert.equal(typeof steps[s.id], 'function', `${wf.id}: a step for ${s.id}`)
    }
  }
})

test('spawnStage logs both streams, returns stdout, and fails with the stderr tail', async () => {
  const log = []
  const h = { log: (l) => log.push(l) }
  const r = await spawnStage({ cmd: process.execPath, args: ['-e', "console.log('out1'); console.error('err1'); console.log('out2')"], h })
  assert.deepEqual(r.lines, ['out1', 'out2'])
  assert.deepEqual(log.sort(), ['err1', 'out1', 'out2'])
  await assert.rejects(spawnStage({ cmd: process.execPath, args: ['-e', "console.error('a'); console.error('b'); process.exit(3)"], h }), (e) => e.code === 'E_WORKFLOW_FAILED' && e.message === 'a | b')
  await assert.rejects(spawnStage({ cmd: process.execPath, args: ['-e', 'process.exit(4)'], h }), (e) => e.code === 'E_WORKFLOW_FAILED' && /exited 4/.test(e.message))
  await assert.rejects(spawnStage({ cmd: 'definitely-not-a-command', h }), (e) => e.code === 'E_SPAWN' && /not found/.test(e.message))
})

test('spawnStage passes arguments as data, never through a shell', async () => {
  const r = await spawnStage({ cmd: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '$(echo hi)', '; rm -rf /', '`x`', 'a b'], h: { log() {} } })
  assert.deepEqual(JSON.parse(r.lines[0]), ['$(echo hi)', '; rm -rf /', '`x`', 'a b'])
})

test('a child gets PATH and what the workflow passes, and nothing else from the server', async () => {
  process.env.DATABASE_URL = 'postgres://secret'
  try {
    const root = standIn()
    const { job } = await go(createWorkflows({ root, env: { EXTRA: 'yes' } }), 'smoke-origin', {})
    const line = logs(job).find((l) => l.startsWith('DATABASE_URL'))
    assert.equal(line, 'DATABASE_URL=absent PATH=set EXTRA=yes')
  } finally {
    delete process.env.DATABASE_URL
  }
})

test('probe sources passes the origin and reports the script\'s last line', async () => {
  const { job } = await go(createWorkflows({ root: standIn() }), 'probe-sources', {})
  assert.equal(job.status, 'success')
  assert.ok(logs(job).includes('scripts/probe-sources.mjs args=["http://localhost:5173"]'))
  assert.equal(job.stages[0].summary, '3/4 reachable, 2 with usable CORS')
})

test('fetch sources counts downloads, refuses ids that are not in the manifest, and a failing script fails the run', async () => {
  const root = standIn()
  const ok = await go(createWorkflows({ root }), 'fetch-sources', { ids: ['bbb', 'have-it', 'sintel'] })
  assert.equal(ok.job.stages[0].summary, '2 downloaded, 1 already there')
  const bad = await go(createWorkflows({ root }), 'fetch-sources', { ids: ['bbb', 'nope'] })
  assert.equal(bad.job.status, 'failed')
  assert.equal(bad.job.stages[0].result.code, 'E_UNKNOWN_ID')
  assert.match(bad.job.stages[0].summary, /nope/)
  const failing = standIn({ 'scripts/fetch-sources.mjs': "console.error('FAIL  bbb: HTTP 404'); process.exitCode = 1" })
  const f = await go(createWorkflows({ root: failing }), 'fetch-sources', { ids: ['bbb'] })
  assert.equal(f.job.status, 'failed')
  assert.match(f.job.stages[0].summary, /HTTP 404/)
})

test('make ads and the smoke test run their scripts with the right arguments', async () => {
  const root = standIn()
  const ads = await go(createWorkflows({ root }), 'make-ads', { ids: ['bumper-6'] })
  assert.ok(logs(ads.job).includes('scripts/make-ads.mjs args=["bumper-6"]'))
  const smoke = await go(createWorkflows({ root }), 'smoke-origin', { slug: 'bbb' })
  assert.ok(logs(smoke.job).includes('tools/smoke-origin.mjs args=["bbb"]'))
  const self = await go(createWorkflows({ root }), 'smoke-origin', {})
  assert.ok(logs(self.job).includes('tools/smoke-origin.mjs args=[]'))
})

test('the benchmark runs in process, keeps its report with the run, and leaves bench/report.json alone', async () => {
  const root = standIn()
  const seen = {}
  const bench = async (o, h) => {
    Object.assign(seen, o)
    h.progress(0.5)
    h.log('round 1 of 2')
    return { generatedAt: 'x', config: { slug: o.slug, segments: 2, rounds: 2, targets: o.targets }, results: { local: { requests: 6, errors: 0, ttfbMs: { p50: 1, p95: 2, p99: 3 }, segmentMs: { p50: 4 }, segmentMbps: 100, hitRatio: null } }, perRound: {}, cost: {} }
  }
  const { job, work } = await go(createWorkflows({ root, bench }), 'bench', { targets: ['local=http://localhost:8788/'], rounds: 2, segments: 2 })
  assert.equal(job.status, 'success')
  assert.deepEqual(stages(job), { run: 'success', report: 'success' })
  assert.deepEqual(seen.targets, [{ name: 'local', base: 'http://localhost:8788' }])
  assert.deepEqual([seen.slug, seen.rounds, seen.segments], ['bbb', 2, 2])
  assert.equal(seen.rates._note, 'n')
  assert.match(job.stages[0].result.lines[1], /^local /)
  assert.equal(job.stages[1].result.file, 'report.json')
  assert.equal(JSON.parse(readFileSync(join(work, 'runs', job.id, 'report.json'), 'utf8')).config.slug, 'bbb')
  assert.ok(!existsSync(join(root, 'bench/report.json')))
})

test('a benchmark that cannot find its title fails the run with the reason', async () => {
  const root = standIn()
  const { job } = await go(createWorkflows({ root, originDir: join(root, 'origin') }), 'bench', { targets: ['local=http://localhost:1'], slug: 'missing' })
  assert.equal(job.status, 'failed')
  assert.match(job.stages[0].summary, /ENOENT/)
  assert.equal(job.stages[1].status, 'skipped')
})

// --- package a title, for real ----------------------------------------------------------------------------------

function clip(file) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file])
}

test('package a title: a real run probes, packages beside the title, verifies and swaps it in', { skip: skipFfmpeg }, async () => {
  const mediaDir = fresh('media')
  const originDir = fresh('origin')
  clip(join(mediaDir, 'demo.mp4'))
  put(originDir, 'demo/old.txt', 'the previous title')
  const { job } = await go(createWorkflows({ mediaDir, originDir }), 'package-title', { id: 'demo', quick: true })
  assert.equal(job.status, 'success', JSON.stringify(job.stages.map((s) => [s.id, s.status, s.summary])))
  assert.deepEqual(stages(job), { probe: 'success', package: 'success', verify: 'success' })
  assert.match(job.stages[0].summary, /720p source, 360p, 720p/)
  const files = readdirSync(join(originDir, 'demo'))
  assert.ok(files.includes(HLS_MASTER) && files.includes(DASH_MANIFEST))
  assert.deepEqual(files.filter((f) => !isTitleFile(f)), [], 'only layout names were written')
  assert.ok(!files.includes('old.txt'), 'the previous title was replaced')
  assert.deepEqual(readdirSync(originDir).filter((f) => f.startsWith('.tmp')), [], 'no staging directory is left')
})

test('package a title: a missing source stops before anything is touched', async () => {
  const mediaDir = fresh('media')
  const originDir = fresh('origin')
  put(originDir, 'demo/keep.txt', 'keep me')
  const { job } = await go(createWorkflows({ mediaDir, originDir }), 'package-title', { id: 'demo' })
  assert.equal(job.status, 'failed')
  assert.equal(job.stages[0].result.code, 'E_NO_SOURCE')
  assert.match(job.stages[0].summary, /Fetch sources/)
  assert.deepEqual(stages(job), { probe: 'failed', package: 'skipped', verify: 'skipped' })
  assert.equal(readFileSync(join(originDir, 'demo/keep.txt'), 'utf8'), 'keep me')
})

test('package a title: a packager that fails leaves the existing title in place and no staging behind', { skip: skipFfmpeg }, async () => {
  const root = standIn({ 'scripts/package-title.mjs': "console.error('ffmpeg exploded'); process.exit(1)" })
  const mediaDir = fresh('media')
  const originDir = fresh('origin')
  clip(join(mediaDir, 'demo.mp4'))
  put(originDir, 'demo/keep.txt', 'keep me')
  // The probe stage reads the height with the real helper; the package stage runs the stand-in script that fails.
  const { job } = await go(createWorkflows({ root, mediaDir, originDir }), 'package-title', { id: 'demo' })
  assert.deepEqual(stages(job), { probe: 'success', package: 'failed', verify: 'skipped' })
  assert.match(job.stages[1].summary, /ffmpeg exploded/)
  assert.equal(readFileSync(join(originDir, 'demo/keep.txt'), 'utf8'), 'keep me')
  assert.deepEqual(readdirSync(originDir).filter((f) => f.startsWith('.tmp')), [])
})
