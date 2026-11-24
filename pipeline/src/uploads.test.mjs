import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { SKIP, openTestDb } from './db/testing.mjs'
import { createUploads, errorCodeOf, parseCursor } from './db/uploads.mjs'
import { createUsers } from './db/users.mjs'
import { publicJob } from './jobs.mjs'
import { finishStage, newJob, startStage } from './stages.mjs'

const db = await openTestDb()

const BASE = 1_795_000_000_000
function job(id, { userId, at = BASE, fail, name = `${id}.mov` } = {}) {
  let j = newJob({ id, now: at, meta: { name, bytes: 1234, sha256: 'a'.repeat(64), outputId: `ugc-${id}`, source: '/secret/path.mov', ...(userId ? { userId } : {}) } })
  j = finishStage(startStage(j, 'upload', at), 'upload', { summary: 'ok' }, at + 10)
  j = finishStage(startStage(j, 'probe', at + 10), 'probe', { summary: 'probed' }, at + 20)
  if (fail) return finishStage(startStage(j, 'validate', at + 20), 'validate', { status: 'failed', summary: 'rejected', result: { code: fail } }, at + 30)
  return j
}
const finish = (j, at) => j.stages.reduce((acc, s) => (s.status === 'queued' ? finishStage(startStage(acc, s.id, at), s.id, {}, at + 5) : acc), j)

describe('upload history', { skip: !db && SKIP }, () => {
  after(() => db?.close())
  const users = db && createUsers(db.pool)
  let pat, sam, admin, uploads

  test('setup', async () => {
    admin = await users.create({ username: 'admin', password: 'password1', role: 'admin' })
    pat = await users.create({ username: 'pat', password: 'password1' })
    sam = await users.create({ username: 'sam', password: 'password1' })
    uploads = createUploads(db.pool, { fallbackUserId: async () => admin.id })
  })

  test('records a running job, then updates the same row when it finishes', async () => {
    const running = job('aaaaaaa1', { userId: pat.id })
    assert.equal(await uploads.upsert(running), true)
    let row = (await uploads.list(pat)).uploads[0]
    assert.equal(row.status, 'running')
    assert.equal(row.endedAt, null)
    assert.equal(row.name, 'aaaaaaa1.mov')
    assert.equal(row.bytes, 1234)
    assert.equal(row.owner, 'pat')

    await uploads.upsert(finish(running, BASE + 100))
    const all = (await uploads.list(pat)).uploads
    assert.equal(all.length, 1, 'same row, not a second one')
    row = all[0]
    assert.equal(row.status, 'success')
    assert.equal(row.endedAt, BASE + 105)
    assert.equal(row.durationMs, 105)
    assert.equal(row.errorCode, null)
    const stages = await db.pool.query('SELECT stage, status FROM upload_stages WHERE upload_id = $1 ORDER BY stage', ['aaaaaaa1'])
    assert.equal(stages.rowCount, 8)
    assert.ok(stages.rows.every((r) => r.status === 'success'))
  })

  test('upserting the same snapshot twice changes nothing', async () => {
    const j = finish(job('aaaaaaa2', { userId: pat.id, at: BASE + 1000 }), BASE + 1100)
    await uploads.upsert(j)
    await uploads.upsert(j)
    assert.equal((await db.pool.query(`SELECT count(*) AS n FROM uploads WHERE id = 'aaaaaaa2'`)).rows[0].n, '1')
    assert.equal((await db.pool.query(`SELECT count(*) AS n FROM upload_stages WHERE upload_id = 'aaaaaaa2'`)).rows[0].n, '8')
  })

  test('a failed job keeps the stable error code of the failing stage', async () => {
    const j = job('aaaaaaa3', { userId: pat.id, at: BASE + 2000, fail: 'E_NO_VIDEO' })
    assert.equal(errorCodeOf(j), 'E_NO_VIDEO')
    await uploads.upsert(j)
    const row = (await uploads.get(pat, 'aaaaaaa3'))
    assert.equal(row.status, 'failed')
    assert.equal(row.errorCode, 'E_NO_VIDEO')
  })

  test('the stored snapshot has no filesystem path and no owner id', async () => {
    const got = await uploads.get(pat, 'aaaaaaa1')
    assert.equal(JSON.stringify(got.job).includes('/secret/path.mov'), false)
    assert.equal('userId' in got.job.meta, false)
    assert.deepEqual(got.job, JSON.parse(JSON.stringify(publicJob(finish(job('aaaaaaa1', { userId: pat.id }), BASE + 100)))))
  })

  test("a user sees only their own uploads, and another user's id is simply not found", async () => {
    await uploads.upsert(job('bbbbbbb1', { userId: sam.id, at: BASE + 3000 }))
    assert.deepEqual((await uploads.list(sam)).uploads.map((u) => u.id), ['bbbbbbb1'])
    assert.equal((await uploads.list(pat)).uploads.some((u) => u.id === 'bbbbbbb1'), false)
    assert.equal(await uploads.get(pat, 'bbbbbbb1'), undefined)
    assert.equal((await uploads.get(sam, 'bbbbbbb1')).owner, 'sam')
  })

  test('an admin sees everyone, with the owner named', async () => {
    const all = (await uploads.list(admin)).uploads
    assert.deepEqual(new Set(all.map((u) => u.owner)), new Set(['pat', 'sam']))
    assert.ok(await uploads.get(admin, 'bbbbbbb1'))
  })

  test('a job from before accounts belongs to the fallback owner, and is skipped when there is none', async () => {
    await uploads.upsert(job('ccccccc1', { at: BASE + 4000 }))
    assert.equal((await uploads.get(admin, 'ccccccc1')).owner, 'admin')
    assert.equal(await uploads.get(pat, 'ccccccc1'), undefined)
    const none = createUploads(db.pool)
    assert.equal(await none.upsert(job('ccccccc2', { at: BASE + 5000 })), false)
  })

  test('pages newest first with a cursor, and the last page has no next', async () => {
    const first = await uploads.list(admin, { limit: 2 })
    assert.equal(first.uploads.length, 2)
    assert.ok(first.next)
    assert.ok(first.uploads[0].createdAt >= first.uploads[1].createdAt)
    const seen = [...first.uploads]
    let next = first.next
    while (next) {
      const page = await uploads.list(admin, { limit: 2, before: next })
      seen.push(...page.uploads)
      next = page.next
    }
    const ids = seen.map((u) => u.id)
    assert.equal(new Set(ids).size, ids.length, 'no row repeated')
    assert.equal(ids.length, 5)
    assert.deepEqual(ids, [...ids].sort((a, b) => seen.find((u) => u.id === b).createdAt - seen.find((u) => u.id === a).createdAt))
  })

  test('rows with the same timestamp are not lost across a page boundary', async () => {
    await uploads.upsert(job('ddddddd1', { userId: sam.id, at: BASE + 9000 }))
    await uploads.upsert(job('ddddddd2', { userId: sam.id, at: BASE + 9000 }))
    const a = await uploads.list(sam, { limit: 1 })
    const b = await uploads.list(sam, { limit: 1, before: a.next })
    assert.deepEqual([a.uploads[0].id, b.uploads[0].id], ['ddddddd2', 'ddddddd1'])
  })

  test('a bad cursor is ignored and the limit is clamped', async () => {
    assert.equal(parseCursor('nope'), null)
    assert.equal(parseCursor("1_'; DROP TABLE uploads"), null)
    assert.ok((await uploads.list(admin, { before: 'nope', limit: 100000 })).uploads.length > 0)
    assert.ok((await uploads.list(admin, { limit: -5 })).uploads.length >= 1)
  })

  test('deleting a user is refused while they own uploads', async () => {
    await assert.rejects(db.pool.query('DELETE FROM users WHERE id = $1', [pat.id]), /violates foreign key/)
  })
})
