import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { createRuns } from './db/runs.mjs'
import { SKIP, openTestDb } from './db/testing.mjs'
import { createUsers } from './db/users.mjs'
import { finishStage, newJob, startStage } from './stages.mjs'

const db = await openTestDb()

describe('workflow run history', { skip: !db && SKIP }, () => {
  after(() => db?.close())
  const repo = db && createRuns(db.pool)
  let alice, bob, admin
  let seq = 0

  const stagesOf = [{ id: 'run', label: 'Run', needs: [] }, { id: 'report', label: 'Report', needs: ['run'] }]
  const job = (userId, { workflow = 'bench', params = { slug: 'bbb' }, dryRun = false, createdAt } = {}) =>
    newJob({ id: `0000000${++seq}`.slice(-8), meta: { workflow, name: workflow, params, dryRun, userId }, now: createdAt ?? 1_000_000 + seq * 1000, stages: stagesOf })
  const finished = (j, { fail = false } = {}) => {
    let x = startStage(j, 'run', j.createdAt + 10)
    x = fail ? finishStage(x, 'run', { status: 'failed', summary: 'x', result: { code: 'E_X' } }, j.createdAt + 500) : finishStage(x, 'run', { summary: 'ok' }, j.createdAt + 500)
    if (!fail) x = finishStage(startStage(x, 'report', j.createdAt + 500), 'report', { summary: 'w' }, j.createdAt + 900)
    return x
  }

  test('setup', async () => {
    const users = createUsers(db.pool)
    alice = await users.create({ username: 'alice-runs', password: 'a-long-enough-password' })
    bob = await users.create({ username: 'bob-runs', password: 'a-long-enough-password' })
    admin = await users.create({ username: 'admin-runs', password: 'a-long-enough-password', role: 'admin' })
  })

  test('a run is recorded as it changes and ends with its duration and outcome', async () => {
    const j = job(alice.id)
    assert.equal(await repo.upsert(j), true)
    let row = await repo.get(alice, j.id)
    assert.equal(row.status, 'queued')
    assert.equal(row.endedAt, null)
    assert.deepEqual(row.params, { slug: 'bbb' })
    await repo.upsert(finished(j))
    row = await repo.get(alice, j.id)
    assert.equal(row.status, 'success')
    assert.equal(row.durationMs, 900)
    assert.equal(row.errorCode, null)
    assert.equal(row.owner, 'alice-runs')
    assert.equal(row.job.meta.userId, undefined, 'the snapshot does not carry the owner id')
  })

  test('a failed run keeps the failing stage code', async () => {
    const j = job(alice.id)
    await repo.upsert(finished(j, { fail: true }))
    assert.equal((await repo.get(alice, j.id)).errorCode, 'E_X')
  })

  test('a run with no owner is not recorded', async () => {
    assert.equal(await repo.upsert(job(null)), false)
  })

  test('a user sees their own runs, an admin sees everyone\'s, and one user cannot read another\'s', async () => {
    const b = job(bob.id)
    await repo.upsert(b)
    assert.ok((await repo.list(alice)).runs.every((r) => r.owner === 'alice-runs'))
    assert.ok((await repo.list(admin)).runs.some((r) => r.owner === 'bob-runs'))
    assert.equal(await repo.get(alice, b.id), undefined)
    assert.ok(await repo.get(admin, b.id))
  })

  test('the list pages newest first by cursor and can be narrowed to one workflow', async () => {
    for (let i = 0; i < 5; i++) await repo.upsert(job(bob.id, { workflow: 'upload-s3', params: { slug: `t${i}`, bucket: 'b' }, dryRun: i % 2 === 0, createdAt: 5_000_000 + i * 1000 }))
    const p1 = await repo.list(bob, { workflow: 'upload-s3', limit: 2 })
    assert.equal(p1.runs.length, 2)
    assert.ok(p1.next)
    const p2 = await repo.list(bob, { workflow: 'upload-s3', limit: 2, before: p1.next })
    const p3 = await repo.list(bob, { workflow: 'upload-s3', limit: 2, before: p2.next })
    const all = [...p1.runs, ...p2.runs, ...p3.runs]
    assert.equal(all.length, 5)
    assert.equal(p3.next, null)
    assert.deepEqual(all.map((r) => r.params.slug), ['t4', 't3', 't2', 't1', 't0'])
    assert.deepEqual(all.map((r) => r.dryRun), [true, false, true, false, true])
    assert.ok(all.every((r) => r.workflow === 'upload-s3'))
  })

  test('hostile input is data: a filter or cursor that is not what it should be matches nothing and breaks nothing', async () => {
    assert.deepEqual((await repo.list(admin, { workflow: "x'; DROP TABLE workflow_runs; --" })).runs, [])
    assert.ok((await repo.list(admin, { before: 'garbage' })).runs.length > 0, 'a bad cursor is ignored')
    assert.equal(await repo.get(admin, "x' OR '1'='1"), undefined)
  })
})
