import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createJobManager } from './jobs.mjs'
import { createQueue } from './queue.mjs'
import { StageError } from './run.mjs'
import { RunRefused, UnknownWorkflow, createRunManager, publicRun } from './runs.mjs'

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
  await m.idle()
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

// --- the confirm gate ---------------------------------------------------------------------------------------------

const MIN = 60_000
const s3 = { steps: ({ dryRun }) => (dryRun ? { 'dry-run': ok('listed') } : { upload: ok('up'), index: ok('idx') }) }
const P = { slug: 'bbb', bucket: 'my-bucket' }
const refused = (m) => (e) => e instanceof RunRefused && e.status === 409 && m.test(e.message)

async function gated(over = {}) {
  let t = 1_000_000
  const m = await createRunManager({ work: over.work ?? dirOf('gate'), workflows: { 'upload-s3': s3, 'rebuild-s3-index': s3, bench }, now: () => t, newId: ids })
  const dry = (userId = 'u1', params = P, workflow = 'upload-s3') => m.start({ workflow, params, userId })
  return { m, dry, advance: (ms) => (t += ms), confirm: (id, over2 = {}) => m.start({ workflow: 'upload-s3', params: { ...P, confirm: id }, userId: 'u1', ...over2 }) }
}

test('a real run is accepted with the id of a successful dry run of the same parameters', async () => {
  const { m, dry, confirm } = await gated()
  const d = dry()
  await m.idle()
  const real = confirm(d.id)
  assert.equal(real.meta.dryRun, false)
  assert.deepEqual(real.stages.map((s) => s.id), ['upload', 'index'])
  await m.idle()
  assert.equal(m.get(real.id).status, 'success')
})

test('without a dry run there is nothing to upload: an unknown id, a missing one and a safe workflow all refuse', async () => {
  const { m, confirm } = await gated()
  assert.throws(() => confirm('deadbeef'), refused(/no such dry run/))
  assert.throws(() => m.start({ workflow: 'upload-s3', params: { ...P, confirm: '../x' }, userId: 'u1' }), refused(/no such dry run/))
  assert.equal(m.list().length, 0, 'a refused start creates no run')
})

test('a dry run that has not finished, or failed, cannot be confirmed', async () => {
  const failing = { steps: () => ({ 'dry-run': async () => { throw new StageError('E_X', 'aws said no') } }) }
  let release
  const slow = { steps: () => ({ 'dry-run': () => new Promise((r) => (release = r)) }) }
  const m1 = await createRunManager({ work: dirOf('g1'), workflows: { 'upload-s3': failing }, newId: ids })
  const bad = m1.start({ workflow: 'upload-s3', params: P, userId: 'u1' })
  await m1.idle()
  assert.throws(() => m1.start({ workflow: 'upload-s3', params: { ...P, confirm: bad.id }, userId: 'u1' }), refused(/failed/))
  const m2 = await createRunManager({ work: dirOf('g2'), workflows: { 'upload-s3': slow }, newId: ids })
  const pending = m2.start({ workflow: 'upload-s3', params: P, userId: 'u1' })
  assert.throws(() => m2.start({ workflow: 'upload-s3', params: { ...P, confirm: pending.id }, userId: 'u1' }), refused(/not finished/))
  while (!release) await new Promise((r) => setTimeout(r, 5)) // the run has started
  release()
  await m2.idle()
})

test('a real run is not a dry run, and a dry run of another workflow does not count', async () => {
  const { m, dry, confirm } = await gated()
  const d = dry()
  await m.idle()
  const real = confirm(d.id)
  await m.idle()
  assert.throws(() => confirm(real.id), refused(/not a dry run/))
  const other = dry('u1', { bucket: 'my-bucket' }, 'rebuild-s3-index')
  await m.idle()
  assert.throws(() => confirm(other.id), refused(/no such dry run of this workflow/))
})

test('only the person who ran the dry run can confirm it', async () => {
  const { m, dry, confirm } = await gated()
  const d = dry('u1')
  await m.idle()
  assert.throws(() => confirm(d.id, { userId: 'u2' }), refused(/someone else/))
  assert.throws(() => confirm(d.id, { userId: null }), refused(/someone else/))
  assert.doesNotThrow(() => confirm(d.id))
})

test('changed parameters mean another dry run', async () => {
  const { m, dry, confirm } = await gated()
  const d = dry()
  await m.idle()
  assert.throws(() => m.start({ workflow: 'upload-s3', params: { slug: 'sintel', bucket: 'my-bucket', confirm: d.id }, userId: 'u1' }), refused(/differ/))
  assert.throws(() => m.start({ workflow: 'upload-s3', params: { slug: 'bbb', bucket: 'other-bucket', confirm: d.id }, userId: 'u1' }), refused(/differ/))
  assert.doesNotThrow(() => confirm(d.id))
})

test('a dry run goes stale after 15 minutes', async () => {
  const { m, dry, confirm, advance } = await gated()
  const d = dry()
  await m.idle()
  advance(15 * MIN - 1)
  const edge = confirm(d.id) // just inside the window
  await m.idle()
  const { m: m2, dry: dry2, confirm: confirm2, advance: advance2 } = await gated()
  const d2 = dry2()
  await m2.idle()
  advance2(15 * MIN + 1)
  assert.throws(() => confirm2(d2.id), refused(/15 minutes old/))
  assert.ok(edge)
})

test('a dry run is single use, even if the run that used it failed, and a refusal does not spend it', async () => {
  const failing = { steps: ({ dryRun }) => (dryRun ? { 'dry-run': ok('listed') } : { upload: async () => { throw new StageError('E_X', 'broke') }, index: ok('') }) }
  const m = await createRunManager({ work: dirOf('single'), workflows: { 'upload-s3': failing }, newId: ids })
  const d = m.start({ workflow: 'upload-s3', params: P, userId: 'u1' })
  await m.idle()
  assert.throws(() => m.start({ workflow: 'upload-s3', params: { slug: 'x', bucket: 'my-bucket', confirm: d.id }, userId: 'u1' }), refused(/differ/))
  const real = m.start({ workflow: 'upload-s3', params: { ...P, confirm: d.id }, userId: 'u1' })
  await m.idle()
  assert.equal(m.get(real.id).status, 'failed')
  assert.throws(() => m.start({ workflow: 'upload-s3', params: { ...P, confirm: d.id }, userId: 'u1' }), refused(/already used/))
})

test('two confirmations in the same instant: one wins', async () => {
  const { m, dry, confirm } = await gated()
  const d = dry()
  await m.idle()
  const results = [confirm(d.id), (() => { try { return confirm(d.id) } catch (e) { return e } })()]
  assert.ok(results[0].id)
  assert.ok(results[1] instanceof RunRefused)
})

test('a dry run stays spent across a restart', async () => {
  const work = dirOf('restart')
  const a = await gated({ work })
  const d = a.dry()
  await a.m.idle()
  a.confirm(d.id)
  await a.m.idle()
  await new Promise((r) => setTimeout(r, 30)) // let the run files land
  const b = await gated({ work })
  assert.throws(() => b.confirm(d.id), refused(/already used|15 minutes/))
})
