import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { parseSettings } from '../../shared/src/settings.ts'
import { createRateLimiter } from './auth.mjs'
import { createSessions } from './db/sessions.mjs'
import { createSettings } from './db/settings.mjs'
import { SKIP, openTestDb } from './db/testing.mjs'
import { createUsers, seedAdmin } from './db/users.mjs'
import { createPipelineServer, ifMatchRevision } from './server.mjs'

const db = await openTestDb()
const quick = async () => ({ summary: 'ok' })
const steps = { probe: quick, validate: quick, normalise: quick, ladder: quick, package: quick, verify: quick, publish: quick }

test('If-Match is a bare or quoted whole number, and nothing else', () => {
  assert.equal(ifMatchRevision(undefined), undefined)
  assert.equal(ifMatchRevision('7'), 7)
  assert.equal(ifMatchRevision('"7"'), 7)
  assert.equal(ifMatchRevision(' "0" '), 0)
  for (const bad of ['', 'x', '-1', '1.5', '"7', 'W/"7"', '*', '1e3', '9'.repeat(16)]) assert.ok(Number.isNaN(ifMatchRevision(bad)), bad)
})

describe('settings API', { skip: !db && SKIP }, () => {
  const cleanup = []
  after(async () => {
    for (const f of cleanup) await f()
    await db?.close()
  })

  async function start({ withSettings = true } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-settings-'))
    const users = createUsers(db.pool)
    await db.pool.query('TRUNCATE users CASCADE')
    await db.pool.query('TRUNCATE app_settings')
    await seedAdmin(users)
    await users.create({ username: 'bob', password: 'a-long-enough-password', role: 'user' })
    const auth = { users, sessions: createSessions(db.pool), limiter: createRateLimiter({ limit: 50 }), dbStatus: async () => null }
    const { server } = await createPipelineServer({
      work: join(root, 'work'), origin: join(root, 'origin'), profile: { limits: { maxFileBytes: 1000 } }, steps, auth,
      ...(withSettings && { settings: createSettings(db.pool) }),
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    cleanup.push(async () => { server.close(); server.closeAllConnections(); await rm(root, { recursive: true, force: true }) })
    const base = `http://127.0.0.1:${server.address().port}/api/pipeline`
    const login = async (username, password) => {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
      return { Cookie: `sid=${/sid=([^;]+)/.exec(res.headers.get('set-cookie'))[1]}` }
    }
    const admin = await login('admin', 'admin')
    const bob = await login('bob', 'a-long-enough-password')
    const call = (method, path, { headers = {}, body } = {}) =>
      fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body !== undefined && { body: JSON.stringify(body) }) })
    return { base, admin, bob, call }
  }

  test('anyone can read settings, signed out too, and a fresh store is empty', async () => {
    const t = await start()
    const res = await t.call('GET', '/settings')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await res.json(), { revision: 0, overrides: {}, revisions: {} })
  })

  test('changing settings needs a session, and an admin one', async () => {
    const t = await start()
    assert.equal((await t.call('PUT', '/settings/player', { body: { adsEnabled: false } })).status, 401)
    assert.equal((await t.call('DELETE', '/settings/player/adsEnabled')).status, 401)
    assert.equal((await t.call('PUT', '/settings/player', { headers: t.bob, body: { adsEnabled: false } })).status, 403)
    assert.equal((await t.call('DELETE', '/settings/player/adsEnabled', { headers: t.bob })).status, 403)
    assert.deepEqual(await (await t.call('GET', '/settings')).json(), { revision: 0, overrides: {}, revisions: {} }, 'nothing was stored')
    assert.equal((await t.call('GET', '/settings', { headers: t.bob })).status, 200, 'a signed-in user can still read')
  })

  test('an admin stores a group in its normalised form, and the stored settings read back through the shared parser', async () => {
    const t = await start()
    const put = await t.call('PUT', '/settings/deliveries', { headers: t.admin, body: { 's3-near.base': ' https://near.example.com/ ', 'local.enabled': false } })
    assert.equal(put.status, 200)
    const stored = await put.json()
    assert.equal(stored.group, 'deliveries')
    assert.deepEqual(stored.value, { 's3-near.base': 'https://near.example.com', 'local.enabled': false })
    assert.ok(stored.revision > 0)
    assert.equal(put.headers.get('etag'), `"${stored.revision}"`)

    const doc = parseSettings(await (await t.call('GET', '/settings')).json())
    assert.equal(doc.revision, stored.revision)
    assert.deepEqual(doc.overrides, { deliveries: stored.value })
    assert.deepEqual(doc.revisions, { deliveries: stored.revision })
  })

  test('a bad value is a 400 that names every field, and stores nothing', async () => {
    const t = await start()
    const res = await t.call('PUT', '/settings/packaging', { headers: t.admin, body: { packager: 'nope', image: '--privileged', ladderCrf: 21, mystery: 1 } })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.deepEqual(Object.keys(body.errors).sort(), ['image', 'mystery', 'packager'])
    assert.deepEqual((await (await t.call('GET', '/settings')).json()).overrides, {})
  })

  test('a body that is not an object is a 400, and an unknown group or route is a 404', async () => {
    const t = await start()
    assert.equal((await t.call('PUT', '/settings/player', { headers: t.admin, body: [1] })).status, 400)
    assert.equal((await t.call('PUT', '/settings/nope', { headers: t.admin, body: {} })).status, 404)
    assert.equal((await t.call('PUT', '/settings/player/adsEnabled', { headers: t.admin, body: {} })).status, 404, 'PUT is for a whole group')
    assert.equal((await t.call('DELETE', '/settings/player', { headers: t.admin })).status, 404, 'DELETE is for one field')
    assert.equal((await t.call('POST', '/settings', { headers: t.admin, body: {} })).status, 405)
    assert.equal((await t.call('PATCH', '/settings/player', { headers: t.admin, body: {} })).status, 405)
  })

  test('If-Match: the right revision writes, a stale one is a 409, a malformed one is a 400', async () => {
    const t = await start()
    const first = await (await t.call('PUT', '/settings/origin', { headers: { ...t.admin, 'If-Match': '0' }, body: { liveWindow: 6 } })).json()

    const stale = await t.call('PUT', '/settings/origin', { headers: { ...t.admin, 'If-Match': '0' }, body: { liveWindow: 9 } })
    assert.equal(stale.status, 409)
    assert.match((await stale.json()).error, /changed/)

    const ok = await t.call('PUT', '/settings/origin', { headers: { ...t.admin, 'If-Match': `"${first.revision}"` }, body: { liveWindow: 7 } })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).value.liveWindow, 7)

    assert.equal((await t.call('PUT', '/settings/origin', { headers: { ...t.admin, 'If-Match': 'later' }, body: { liveWindow: 8 } })).status, 400)
    assert.equal((await (await t.call('GET', '/settings')).json()).overrides.origin.liveWindow, 7, 'only the matching write landed')
  })

  test('without If-Match the last write wins', async () => {
    const t = await start()
    await t.call('PUT', '/settings/origin', { headers: t.admin, body: { liveWindow: 6 } })
    assert.equal((await t.call('PUT', '/settings/origin', { headers: t.admin, body: { liveWindow: 8 } })).status, 200)
  })

  test('DELETE resets one field and leaves the others', async () => {
    const t = await start()
    const set = await (await t.call('PUT', '/settings/deliveries', { headers: t.admin, body: { 'local.base': 'http://localhost:9000', 'local.enabled': false } })).json()
    const del = await t.call('DELETE', '/settings/deliveries/local.base', { headers: { ...t.admin, 'If-Match': String(set.revision) } })
    assert.equal(del.status, 200)
    const after = await del.json()
    assert.deepEqual(after.value, { 'local.enabled': false })
    assert.ok(after.revision > set.revision)

    // Resetting a field that was never overridden changes nothing.
    const again = await (await t.call('DELETE', '/settings/deliveries/local.base', { headers: t.admin })).json()
    assert.equal(again.revision, after.revision)
    assert.equal((await t.call('DELETE', '/settings/deliveries/not-a-field', { headers: t.admin })).status, 400)
    assert.equal((await t.call('DELETE', '/settings/deliveries/local.base', { headers: { ...t.admin, 'If-Match': String(set.revision) } })).status, 409)
  })

  test('hostile field names in the path never reach the store', async () => {
    const t = await start()
    for (const field of ['__proto__', 'constructor', '..%2Fx', 'a%20b']) {
      const res = await t.call('DELETE', `/settings/player/${field}`, { headers: t.admin })
      assert.ok([400, 404].includes(res.status), `${field}: ${res.status}`)
    }
  })

  test('a server started without a settings repository has no settings routes', async () => {
    const t = await start({ withSettings: false })
    assert.equal((await t.call('GET', '/settings')).status, 401, 'signed out it is like any other guarded route')
    assert.equal((await t.call('GET', '/settings', { headers: t.admin })).status, 404)
    assert.equal((await t.call('PUT', '/settings/player', { headers: t.admin, body: {} })).status, 405, 'a write falls through to the generic method check')
  })
})
