import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createJobManager } from './jobs.mjs'
import { createQueue } from './queue.mjs'
import { StageError } from './run.mjs'
import { UnknownWorkflow, createRunManager, publicRun } from './runs.mjs'

let work
before(() => (work = mkdtempSync(join(tmpdir(), 'runs-'))))
after(() => rmSync(work, { recursive: true, force: true }))
const dirOf = (name) => mkdtempSync(join(work, `${name}-`))
const stages = (job) => Object.fromEntries(job.stages.map((s) => [s.id, s.status]))
let n = 0
const ids = () => `r${String(++n).padStart(7, '0')}`

const ok = (summary) => async () => ({ summary })
const bench = { steps: () => ({ run: ok('ran'), report: ok('written') }) }

test('a run goes through the stages the registry defines for it', async () => {
  const m = await createRunManager({ work: dirOf('a'), workflows: { bench }, newId: ids })
  const job = m.start({ workflow: 'bench', params: { targets: ['a=http://x'] }, userId: 'u1' })
  assert.deepEqual(job.stages.map((s) => s.id), ['run', 'report'])
  assert.equal(job.status, 'queued')
  await m.idle()
  const done = m.get(job.id)
  assert.equal(done.status, 'success')
  assert.deepEqual(stages(done), { run: 'success', report: 'success' })
  assert.deepEqual(done.meta, { workflow: 'bench', name: 'Run the delivery benchmark', params: { targets: ['a=http://x'] }, dryRun: false, userId: 'u1' })
})

test('a failing stage fails the run and skips what depends on it', async () => {
  const wf = { steps: () => ({ run: async () => { throw new StageError('E_BOOM', 'it broke') }, report: ok('never') }) }
  const m = await createRunManager({ work: dirOf('b'), workflows: { bench: wf }, newId: ids })
  const job = m.start({ workflow: 'bench', params: {} })
  await m.idle()
  const done = m.get(job.id)
  assert.equal(done.status, 'failed')
  assert.deepEqual(stages(done), { run: 'failed', report: 'skipped' })
  assert.equal(done.stages[0].result.code, 'E_BOOM')
})

test('the steps get the params, a run directory that exists, and shared state across stages', async () => {
  const seen = {}
  const wf = {
    steps: ({ params, dryRun }) => ({
      run: async (ctx) => { seen.params = ctx.params; seen.dryRun = dryRun; seen.dir = ctx.dir; seen.exists = existsSync(ctx.dir); ctx.shared.x = 7; writeFileSync(join(ctx.dir, 'report.json'), '{}') },
      report: async (ctx) => { seen.shared = ctx.shared.x },
    }),
  }
  const m = await createRunManager({ work: dirOf('c'), workflows: { bench: wf }, newId: ids })
  const job = m.start({ workflow: 'bench', params: { slug: 'bbb' } })
  await m.idle()
  assert.deepEqual(seen.params, { slug: 'bbb' })
  assert.equal(seen.exists, true)
  assert.match(seen.dir, new RegExp(`runs/${job.id}$`))
  assert.equal(seen.shared, 7)
  assert.equal(readFileSync(join(seen.dir, 'report.json'), 'utf8'), '{}')
})

test('a gated workflow without confirm is the dry run, with its own stages', async () => {
  const built = []
  const wf = { steps: ({ dryRun }) => (built.push(dryRun), { 'dry-run': ok('listed'), upload: ok('up'), index: ok('idx') }) }
  const m = await createRunManager({ work: dirOf('d'), workflows: { 'upload-s3': wf }, newId: ids })
  const dry = m.start({ workflow: 'upload-s3', params: { slug: 'bbb', bucket: 'my-bucket' } })
  assert.deepEqual(dry.stages.map((s) => s.id), ['dry-run'])
  assert.equal(dry.meta.dryRun, true)
  const real = m.start({ workflow: 'upload-s3', params: { slug: 'bbb', bucket: 'my-bucket', confirm: dry.id } })
  assert.deepEqual(real.stages.map((s) => s.id), ['upload', 'index'])
  assert.equal(real.meta.dryRun, false)
  await m.idle()
  assert.deepEqual(built, [true, false])
})

test('a workflow that is unknown, a guide or not implemented here is refused', async () => {
  const m = await createRunManager({ work: dirOf('e'), workflows: { bench }, newId: ids })
  for (const workflow of ['nope', 'shape-network', 'probe-sources', '__proto__', 'toString']) {
    assert.throws(() => m.start({ workflow, params: {} }), (e) => e instanceof UnknownWorkflow && e.status === 404, workflow)
  }
})

test('runs share the queue with upload jobs: one at a time, in the order started', async () => {
  const queue = createQueue()
  const log = []
  let release
  const hold = new Promise((r) => (release = r))
  const uploadSteps = { probe: async () => { log.push('upload start'); await hold; log.push('upload end') } }
  const jobs = await createJobManager({ work: dirOf('f'), steps: uploadSteps, queue })
  const runs = await createRunManager({ work: dirOf('g'), workflows: { bench: { steps: () => ({ run: async () => { log.push('run') }, report: ok('') }) } }, queue, newId: ids })
  jobs.create({ id: 'a1b2c3d4', meta: { name: 'x' }, upload: { startedAt: 0, endedAt: 1, summary: '', result: {} } })
  runs.start({ workflow: 'bench', params: {} })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(log, ['upload start'], 'the run waits for the upload')
  release()
  await runs.idle()
  assert.deepEqual(log, ['upload start', 'upload end', 'run'])
})

test('a run left half-done by a restart comes back as failed, with its params kept', async () => {
  const dir = dirOf('h')
  let release
  const wf = { steps: () => ({ run: () => new Promise((r) => (release = r)), report: ok('') }) }
  const a = await createRunManager({ work: dir, workflows: { bench: wf }, newId: ids })
  const job = a.start({ workflow: 'bench', params: { slug: 'bbb' } })
  await new Promise((r) => setTimeout(r, 30)) // running, and persisted
  const b = await createRunManager({ work: dir, workflows: { bench: wf }, newId: ids })
  const back = b.get(job.id)
  assert.equal(back.status, 'failed')
  assert.equal(back.stages[0].result.code, 'E_INTERRUPTED')
  assert.deepEqual(back.meta.params, { slug: 'bbb' })
  release()
})

test('listing is newest first, can be filtered by who may see a run, and shows no owner', async () => {
  let t = 1000
  const m = await createRunManager({ work: dirOf('i'), workflows: { bench }, now: () => (t += 10), newId: ids })
  const first = m.start({ workflow: 'bench', params: {}, userId: 'u1' })
  const second = m.start({ workflow: 'bench', params: {}, userId: 'u2' })
  await m.idle()
  assert.deepEqual(m.list().map((r) => r.id), [second.id, first.id])
  assert.deepEqual(m.list((j) => j.meta.userId === 'u1').map((r) => r.id), [first.id])
  assert.ok(!('userId' in publicRun(m.get(first.id)).meta))
  assert.deepEqual(Object.keys(m.list()[0]).sort(), ['createdAt', 'dryRun', 'id', 'name', 'params', 'status', 'workflow'])
})

test('state changes reach onChange in order, once per change of state', async () => {
  const seen = []
  const m = await createRunManager({ work: dirOf('j'), workflows: { bench }, newId: ids, onChange: (j) => seen.push(`${j.status}:${j.stages.map((s) => s.status).join(',')}`) })
  m.start({ workflow: 'bench', params: {} })
  await m.idle()
  assert.equal(seen[0], 'queued:queued,queued')
  assert.equal(seen.at(-1), 'success:success,success')
  assert.equal(new Set(seen).size, seen.length, 'progress ticks are not recorded')
})
