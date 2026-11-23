import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { parseRun } from './benchmarks.mjs'
import { createBenchmarks, isRunId, parseCursor } from './db/benchmarks.mjs'
import { SKIP, openTestDb } from './db/testing.mjs'
import { createUsers } from './db/users.mjs'

const db = await openTestDb()

const BASE = 1_795_000_000_000
const ev = (over = {}) => ({ t: 1, slot: 0, streamId: 'bbb-hls', delivery: 'local', type: 'load-start', data: {}, ...over })
const body = (over = {}) => ({
  label: 'run',
  startedAt: BASE,
  endedAt: BASE + 60_000,
  env: { userAgent: 'test' },
  timeOrigin: BASE,
  nowMs: 60_000,
  sessions: [
    { slot: 0, streamId: 'bbb-hls', delivery: 'local', summary: { startupMs: 40, rebufferCount: 0, rebufferRatio: 0, avgBitrateKbps: 2932, meanSegmentLatencyMs: 8, throughputKbps: 5e5, errors: 0 } },
    { slot: 1, streamId: 'bbb-hls', delivery: 's3-near', summary: { startupMs: 120, rebufferCount: 2, rebufferRatio: 0.03, avgBitrateKbps: 1400, meanSegmentLatencyMs: 90, throughputKbps: 9e4, errors: 1 } },
  ],
  events: [ev(), ev({ type: 'first-frame', t: 41 }), ev({ slot: 1, delivery: 's3-near', t: 2 })],
  ...over,
})

describe('benchmark runs', { skip: !db && SKIP }, () => {
  after(() => db?.close())
  const users = db && createUsers(db.pool)
  let pat, sam, admin, runs

  test('setup', async () => {
    admin = await users.create({ username: 'admin', password: 'password1', role: 'admin' })
    pat = await users.create({ username: 'pat', password: 'password1' })
    sam = await users.create({ username: 'sam', password: 'password1' })
    runs = createBenchmarks(db.pool)
  })

  test('a saved run round-trips with its quadrants as real columns', async () => {
    const id = await runs.create(pat.id, parseRun(body()))
    assert.ok(isRunId(id))
    const got = await runs.get(pat, id)
    assert.equal(got.label, 'run')
    assert.equal(got.startedAt, BASE)
    assert.equal(got.endedAt, BASE + 60_000)
    assert.equal(got.owner, 'pat')
    assert.deepEqual(got.env, { userAgent: 'test' })
    assert.deepEqual(got.sessions.map((s) => [s.slot, s.delivery, s.startupMs, s.rebufferCount, s.errors]), [[0, 'local', 40, 0, 0], [1, 's3-near', 120, 2, 1]])
    assert.equal(got.sessions[1].rebufferRatio, 0.03)
    assert.deepEqual(got.artifacts.map((a) => [a.kind, a.schemaVersion]), [['telemetry-events', 1]])
  })

  test('the blob comes back whole, and can be rebuilt into the same events', async () => {
    const input = body()
    const id = await runs.create(pat.id, parseRun(input))
    const blob = await runs.getArtifact(pat, id, 'telemetry-events')
    assert.equal(blob.schemaVersion, 1)
    assert.deepEqual(blob.json.events, input.events)
    assert.equal(blob.json.nowMs, 60_000)
    assert.equal(await runs.getArtifact(pat, id, 'no-such-kind'), undefined)
  })

  test('a failed blob write leaves no run behind', async () => {
    const before = (await db.pool.query('SELECT count(*) AS n FROM benchmark_runs')).rows[0].n
    const parsed = parseRun(body())
    parsed.blob = { json: '{not json', bytes: 9 } // jsonb rejects it
    await assert.rejects(runs.create(pat.id, parsed))
    assert.equal((await db.pool.query('SELECT count(*) AS n FROM benchmark_runs')).rows[0].n, before)
    assert.equal((await db.pool.query('SELECT count(*) AS n FROM benchmark_sessions WHERE run_id NOT IN (SELECT id FROM benchmark_runs)')).rows[0].n, '0')
  })

  test("a user sees only their own runs and artifacts, an admin sees all", async () => {
    const id = await runs.create(sam.id, parseRun(body({ label: 'sams' })))
    assert.equal(await runs.get(pat, id), undefined)
    assert.equal(await runs.getArtifact(pat, id, 'telemetry-events'), undefined)
    assert.equal((await runs.list(pat)).runs.some((r) => r.id === id), false)
    assert.deepEqual((await runs.list(sam)).runs.map((r) => r.label), ['sams'])
    assert.equal((await runs.get(admin, id)).owner, 'sam')
    assert.ok(await runs.getArtifact(admin, id, 'telemetry-events'))
    assert.deepEqual(new Set((await runs.list(admin)).runs.map((r) => r.owner)), new Set(['pat', 'sam']))
  })

  test('the list names the quadrants and carries no blobs', async () => {
    const r = (await runs.list(pat)).runs[0]
    assert.deepEqual(r.sessions.map((s) => s.delivery), ['local', 's3-near'])
    assert.equal('events' in r, false)
  })

  test('pages newest first with a cursor, no repeats', async () => {
    for (let i = 0; i < 3; i++) await runs.create(admin.id, parseRun(body({ label: `a${i}`, startedAt: BASE + 1000 * (i + 1), endedAt: BASE + 1000 * (i + 1) })))
    const seen = []
    let next = null
    do {
      const page = await runs.list(admin, { limit: 2, before: next })
      seen.push(...page.runs)
      next = page.next
    } while (next)
    const ids = seen.map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.deepEqual(seen.map((r) => r.startedAt), [...seen.map((r) => r.startedAt)].sort((a, b) => b - a))
    assert.equal(parseCursor('nope'), null)
    assert.ok((await runs.list(admin, { before: 'nope', limit: 99999 })).runs.length > 0)
  })

  test('only the owner or an admin can delete, and it removes the blob too', async () => {
    const id = await runs.create(pat.id, parseRun(body({ label: 'to delete' })))
    assert.equal(await runs.remove(sam, id), false)
    assert.ok(await runs.get(pat, id))
    assert.equal(await runs.remove(pat, id), true)
    assert.equal(await runs.get(pat, id), undefined)
    assert.equal((await db.pool.query('SELECT count(*) AS n FROM artifacts WHERE owner_id = $1', [id])).rows[0].n, '0')
    assert.equal((await db.pool.query('SELECT count(*) AS n FROM benchmark_sessions WHERE run_id = $1', [id])).rows[0].n, '0')
    assert.equal(await runs.remove(pat, id), false, 'already gone')
    const other = await runs.create(sam.id, parseRun(body({ label: 'admin removes' })))
    assert.equal(await runs.remove(admin, other), true)
  })

  test('ids that are not uuids are treated as missing', async () => {
    assert.equal(await runs.get(admin, 'not-a-uuid'), undefined)
    assert.equal(await runs.remove(admin, "x'; DROP TABLE users;--"), false)
    assert.equal(await runs.getArtifact(admin, '123', 'telemetry-events'), undefined)
  })
})
