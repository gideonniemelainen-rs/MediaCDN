import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { createRateLimiter } from './auth.mjs'
import { createBenchmarks } from './db/benchmarks.mjs'
import { createSessions } from './db/sessions.mjs'
import { SKIP, openTestDb } from './db/testing.mjs'
import { createUsers } from './db/users.mjs'
import { createPipelineServer } from './server.mjs'

const db = await openTestDb()
const quick = async () => ({ summary: 'ok' })
const steps = { probe: quick, validate: quick, normalise: quick, ladder: quick, package: quick, verify: quick, publish: quick }
const BASE = 1_795_000_000_000
const ev = (over = {}) => ({ t: 1, slot: 0, streamId: 'bbb-hls', delivery: 'local', type: 'load-start', data: {}, ...over })
const run = (over = {}) => ({
  label: 'first',
  startedAt: BASE,
  endedAt: BASE + 1000,
  env: {},
  timeOrigin: BASE,
  nowMs: 1000,
  sessions: [{ slot: 0, streamId: 'bbb-hls', delivery: 'local', summary: { startupMs: 40 } }],
  events: [ev()],
  ...over,
})

describe('server benchmark routes', { skip: !db && SKIP }, () => {
  const cleanup = []
  after(async () => {
    for (const f of cleanup) await f()
    await db?.close()
  })

  async function start() {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-bench-'))
    await db.pool.query('TRUNCATE users CASCADE')
    const users = createUsers(db.pool)
    await users.create({ username: 'admin', password: 'adminpass1', role: 'admin' })
    await users.create({ username: 'pat', password: 'patpass12' })
    await users.create({ username: 'sam', password: 'sampass12' })
    const auth = { users, sessions: createSessions(db.pool), limiter: createRateLimiter({ limit: 50 }), dbStatus: async () => null }
    const { server } = await createPipelineServer({
      work: join(root, 'work'), origin: join(root, 'origin'), profile: { limits: { maxFileBytes: 1000 } }, steps, auth,
      history: { benchmarks: createBenchmarks(db.pool) },
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    cleanup.push(async () => { server.close(); server.closeAllConnections(); await rm(root, { recursive: true, force: true }) })
    const base = `http://127.0.0.1:${server.address().port}/api/pipeline`
    const as = {}
    for (const [name, password] of [['admin', 'adminpass1'], ['pat', 'patpass12'], ['sam', 'sampass12']]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', body: JSON.stringify({ username: name, password }) })
      as[name] = { Cookie: `sid=${/sid=([^;]+)/.exec(res.headers.get('set-cookie'))[1]}` }
    }
    const send = (who, method, path, body) =>
      fetch(base + path, { method, headers: { ...as[who], ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { base, as, send }
  }

  test('save, list, open, fetch the blob, delete', async () => {
    const t = await start()
    const saved = await t.send('pat', 'POST', '/benchmarks', run())
    assert.equal(saved.status, 201)
    const { id } = await saved.json()

    const list = await (await t.send('pat', 'GET', '/benchmarks')).json()
    assert.deepEqual(list.runs.map((r) => [r.id, r.label]), [[id, 'first']])
    assert.equal(list.next, null)

    const one = await (await t.send('pat', 'GET', `/benchmarks/${id}`)).json()
    assert.equal(one.sessions[0].startupMs, 40)
    assert.equal(one.artifacts[0].kind, 'telemetry-events')

    const blob = await (await t.send('pat', 'GET', `/benchmarks/${id}/artifacts/telemetry-events`)).json()
    assert.equal(blob.schemaVersion, 1)
    assert.equal(blob.events.length, 1)
    assert.equal(blob.nowMs, 1000)

    assert.equal((await t.send('pat', 'DELETE', `/benchmarks/${id}`)).status, 200)
    assert.equal((await t.send('pat', 'GET', `/benchmarks/${id}`)).status, 404)
    assert.equal((await t.send('pat', 'DELETE', `/benchmarks/${id}`)).status, 404)
  })

  test("another user's run is not found, and cannot be deleted by them", async () => {
    const t = await start()
    const { id } = await (await t.send('pat', 'POST', '/benchmarks', run())).json()
    for (const path of [`/benchmarks/${id}`, `/benchmarks/${id}/artifacts/telemetry-events`]) {
      assert.equal((await t.send('sam', 'GET', path)).status, 404, path)
    }
    assert.equal((await t.send('sam', 'DELETE', `/benchmarks/${id}`)).status, 404)
    assert.deepEqual((await (await t.send('sam', 'GET', '/benchmarks')).json()).runs, [])
    assert.equal((await t.send('admin', 'GET', `/benchmarks/${id}`)).status, 200)
    assert.ok((await t.send('pat', 'GET', `/benchmarks/${id}`)).ok, 'the delete attempt changed nothing')
  })

  test('everything needs a session', async () => {
    const t = await start()
    assert.equal((await fetch(`${t.base}/benchmarks`)).status, 401)
    assert.equal((await fetch(`${t.base}/benchmarks`, { method: 'POST', body: '{}' })).status, 401)
  })

  test('a bad body is a 400 with the reason, and a disallowed Origin is refused', async () => {
    const t = await start()
    const res = await t.send('pat', 'POST', '/benchmarks', run({ sessions: [] }))
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /sessions must list/)
    const notJson = await fetch(`${t.base}/benchmarks`, { method: 'POST', headers: t.as.pat, body: 'not json' })
    assert.equal(notJson.status, 400)
    const cross = await fetch(`${t.base}/benchmarks`, { method: 'POST', headers: { ...t.as.pat, Origin: 'http://evil.example' }, body: JSON.stringify(run()) })
    assert.equal(cross.status, 403)
  })

  test('a body over the limit is a 413', async () => {
    const t = await start()
    const res = await fetch(`${t.base}/benchmarks`, { method: 'POST', headers: t.as.pat, body: JSON.stringify({ pad: 'x'.repeat(10_500_000) }) })
    assert.equal(res.status, 413)
  })

  test('unknown paths and methods are handled', async () => {
    const t = await start()
    assert.equal((await t.send('pat', 'GET', '/benchmarks/not-a-uuid')).status, 404)
    assert.equal((await t.send('pat', 'PUT', '/benchmarks', run())).status, 405)
    assert.equal((await t.send('pat', 'GET', '/benchmarks/00000000-0000-0000-0000-000000000000')).status, 404)
  })

  test('a large run with many samples is saved, thinned, and says so', async () => {
    const t = await start()
    const samples = Array.from({ length: 12_000 }, (_, i) => ev({ type: 'sample', t: i, data: { pad: 'x'.repeat(400) } }))
    const res = await t.send('pat', 'POST', '/benchmarks', run({ events: [ev(), ...samples] }))
    assert.equal(res.status, 201)
    const { id } = await res.json()
    const blob = await (await t.send('pat', 'GET', `/benchmarks/${id}/artifacts/telemetry-events`)).json()
    assert.ok(blob.downsampled.sampleEvents.to < 12_000)
    assert.equal(blob.events.filter((e) => e.type === 'load-start').length, 1)
  })
})
