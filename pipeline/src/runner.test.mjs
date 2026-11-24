import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StageError, runJob } from './run.mjs'
import { STAGES, deriveStatus, finishStage, newJob, readyStages, skipDownstream, startStage } from './stages.mjs'

const fresh = () => newJob({ id: 'a1b2c3d4', meta: { name: 'x.mov' }, now: 0 })
const statuses = (job) => Object.fromEntries(job.stages.map((s) => [s.id, s.status]))
const ok = (summary) => async () => ({ summary })

// Steps for every stage except upload (the server completes that one itself).
const allOk = () => Object.fromEntries(STAGES.filter((s) => s.id !== 'upload').map((s) => [s.id, ok(`${s.id} done`)]))
const withUpload = (job) => finishStage(startStage(job, 'upload', 1), 'upload', { summary: 'received' }, 2)

test('a new job is queued and only stages with no needs are ready', () => {
  const job = fresh()
  assert.equal(job.status, 'queued')
  assert.deepEqual(readyStages(job).map((s) => s.id), ['upload'])
})

test('status is derived from the stages', () => {
  let job = fresh()
  job = startStage(job, 'upload', 1)
  assert.equal(job.status, 'running')
  job = finishStage(job, 'upload', {}, 2)
  assert.equal(job.status, 'running')
  assert.equal(deriveStatus({ stages: [{ status: 'success' }, { status: 'cached' }] }), 'success')
  assert.equal(deriveStatus({ stages: [{ status: 'failed' }, { status: 'skipped' }] }), 'failed')
})

test('runs every stage in dependency order and ends successful', async () => {
  const order = []
  const steps = Object.fromEntries(Object.keys(allOk()).map((id) => [id, async () => { order.push(id); return { summary: id } }]))
  const final = await runJob(withUpload(fresh()), steps, {})
  assert.deepEqual(order, ['probe', 'validate', 'normalise', 'ladder', 'package', 'verify', 'publish'])
  assert.equal(final.status, 'success')
  assert.ok(final.stages.every((s) => s.status === 'success' && s.progress === 1))
})

test('a failing stage records its code and skips everything downstream', async () => {
  const steps = {
    ...allOk(),
    validate: async () => { throw new StageError('E_AUDIO_ONLY', 'audio-only input', { result: { errors: [1] } }) },
  }
  const final = await runJob(withUpload(fresh()), steps, {})
  assert.deepEqual(statuses(final), {
    upload: 'success', probe: 'success', validate: 'failed',
    normalise: 'skipped', ladder: 'skipped', package: 'skipped', verify: 'skipped', publish: 'skipped',
  })
  const failed = final.stages.find((s) => s.id === 'validate')
  assert.equal(failed.summary, 'audio-only input')
  assert.deepEqual(failed.result, { code: 'E_AUDIO_ONLY', errors: [1] })
  assert.equal(final.status, 'failed')
})

test('an unexpected exception fails the stage with E_INTERNAL', async () => {
  const final = await runJob(withUpload(fresh()), { ...allOk(), probe: async () => { throw new TypeError('boom') } }, {})
  assert.equal(final.stages.find((s) => s.id === 'probe').result.code, 'E_INTERNAL')
  assert.equal(final.stages.find((s) => s.id === 'publish').status, 'skipped')
})

test('a missing step fails clearly instead of hanging', async () => {
  const { probe: _omitted, ...steps } = allOk()
  const final = await runJob(withUpload(fresh()), steps, {})
  assert.equal(final.stages.find((s) => s.id === 'probe').result.code, 'E_NO_STEP')
})

test('a step can report a cache hit', async () => {
  const steps = { ...allOk(), normalise: async () => ({ status: 'cached', summary: 'already normalised' }) }
  const final = await runJob(withUpload(fresh()), steps, {})
  assert.equal(final.stages.find((s) => s.id === 'normalise').status, 'cached')
  assert.equal(final.status, 'success')
})

test('steps share state through ctx and report progress and log lines', async () => {
  const ctx = { shared: {} }
  const steps = {
    ...allOk(),
    probe: async (c) => { c.shared.n = 7 },
    validate: async (c, h) => { h.progress(0.5); h.log('half way'); return { summary: String(c.shared.n) } },
  }
  const snapshots = []
  const final = await runJob(withUpload(fresh()), steps, ctx, { emit: (j) => snapshots.push(j), progressEveryMs: 0 })
  const v = final.stages.find((s) => s.id === 'validate')
  assert.equal(v.summary, '7')
  assert.deepEqual(v.log, ['half way'])
  assert.ok(snapshots.some((j) => j.stages.find((s) => s.id === 'validate').progress === 0.5))
})

test('stages that become ready together run in parallel', async () => {
  const diamond = [
    { id: 'a', label: 'A', needs: [] },
    { id: 'b', label: 'B', needs: ['a'] },
    { id: 'c', label: 'C', needs: ['a'] },
    { id: 'd', label: 'D', needs: ['b', 'c'] },
  ]
  let running = 0
  let peak = 0
  const slow = async () => {
    peak = Math.max(peak, ++running)
    await new Promise((r) => setTimeout(r, 20))
    running--
  }
  const final = await runJob(newJob({ id: 'a1b2c3d4', meta: {}, now: 0, stages: diamond }), { a: slow, b: slow, c: slow, d: slow }, {})
  assert.equal(peak, 2)
  assert.equal(final.status, 'success')
})

test('skipDownstream follows the graph transitively and leaves independent branches alone', () => {
  const stages = [
    { id: 'a', label: 'A', needs: [] },
    { id: 'b', label: 'B', needs: ['a'] },
    { id: 'c', label: 'C', needs: ['b'] },
    { id: 'x', label: 'X', needs: [] },
  ]
  let job = newJob({ id: 'a1b2c3d4', meta: {}, now: 0, stages })
  job = finishStage(startStage(job, 'a', 1), 'a', { status: 'failed' }, 2)
  job = skipDownstream(job, 3)
  assert.deepEqual(statuses(job), { a: 'failed', b: 'skipped', c: 'skipped', x: 'queued' })
})
