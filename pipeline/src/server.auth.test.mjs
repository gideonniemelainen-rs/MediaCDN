import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { createRateLimiter } from './auth.mjs'
import { createSessions } from './db/sessions.mjs'
import { SKIP, openTestDb } from './db/testing.mjs'
import { createUsers, seedAdmin } from './db/users.mjs'
import { createPipelineServer } from './server.mjs'

const db = await openTestDb()
const quick = async () => ({ summary: 'ok' })
const steps = { probe: quick, validate: quick, normalise: quick, ladder: quick, package: quick, verify: quick, publish: quick }

describe('server auth', { skip: !db && SKIP }, () => {
  const cleanup = []
  after(async () => {
    for (const f of cleanup) await f()
    await db?.close()
  })

  async function start() {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-auth-'))
    const users = createUsers(db.pool)
    await db.pool.query('TRUNCATE users CASCADE')
    await seedAdmin(users)
    const auth = { users, sessions: createSessions(db.pool), limiter: createRateLimiter({ limit: 3 }), dbStatus: async () => null }
    const { server } = await createPipelineServer({ work: join(root, 'work'), origin: join(root, 'origin'), profile: { limits: { maxFileBytes: 1000 } }, steps, auth })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    cleanup.push(async () => { server.close(); server.closeAllConnections(); await rm(root, { recursive: true, force: true }) })
    const base = `http://127.0.0.1:${server.address().port}/api/pipeline`
    const post = (path, body, headers = {}) =>
      fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const login = (username = 'admin', password = 'admin', extra = {}) => post('/auth/login', { username, password, ...extra })
    return { base, post, login, users }
  }
  const cookieOf = (res) => /sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]

  test('health needs no session and reports the database', async () => {
    const t = await start()
    assert.deepEqual(await (await fetch(`${t.base}/health`)).json(), { ok: true, db: 'ok' })
  })

  test('everything else is 401 without a session', async () => {
    const t = await start()
    for (const path of ['/auth/me', '/jobs', '/stages']) assert.equal((await fetch(t.base + path)).status, 401, path)
    assert.equal((await fetch(`${t.base}/uploads`, { method: 'POST', headers: { 'Content-Length': '3' }, body: 'abc' })).status, 401)
  })

  test('login sets an HttpOnly, SameSite cookie that opens the guarded routes', async () => {
    const t = await start()
    const res = await t.login()
    assert.equal(res.status, 200)
    const header = res.headers.get('set-cookie')
    assert.match(header, /HttpOnly/)
    assert.match(header, /SameSite=Lax/)
    const body = await res.json()
    assert.equal(body.user.username, 'admin')
    assert.equal(body.user.mustChangePassword, true)
    assert.equal('passwordHash' in body.user, false)
    const me = await fetch(`${t.base}/auth/me`, { headers: { Cookie: `sid=${cookieOf(res)}` } })
    assert.equal((await me.json()).user.username, 'admin')
    assert.equal((await fetch(`${t.base}/jobs`, { headers: { Cookie: `sid=${cookieOf(res)}` } })).status, 200)
  })

  test('a bearer login returns a token, sets no cookie, and works in the Authorization header', async () => {
    const t = await start()
    const res = await t.login('admin', 'admin', { bearer: true })
    assert.equal(res.headers.get('set-cookie'), null)
    const { token } = await res.json()
    assert.equal((await fetch(`${t.base}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status, 200)
    assert.equal((await fetch(`${t.base}/auth/me`, { headers: { Authorization: 'Bearer nope' } })).status, 401)
  })

  test('a wrong password and an unknown user get the same answer', async () => {
    const t = await start()
    const a = await t.login('admin', 'nope')
    const b = await t.login('ghost', 'nope')
    assert.equal(a.status, 401)
    assert.deepEqual(await a.json(), await b.json())
  })

  test('repeated failures are rate limited, and a correct login after that is still refused until the window passes', async () => {
    const t = await start()
    for (let i = 0; i < 3; i++) assert.equal((await t.login('admin', 'bad')).status, 401)
    assert.equal((await t.login('admin', 'bad')).status, 429)
    assert.equal((await t.login('admin', 'admin')).status, 429)
  })

  test('logout ends the session', async () => {
    const t = await start()
    const sid = cookieOf(await t.login())
    const out = await t.post('/auth/logout', {}, { Cookie: `sid=${sid}` })
    assert.equal(out.status, 200)
    assert.equal((await fetch(`${t.base}/auth/me`, { headers: { Cookie: `sid=${sid}` } })).status, 401)
  })

  test('changing the password needs the current one, rejects weak ones, and clears the flag', async () => {
    const t = await start()
    const sid = cookieOf(await t.login())
    const h = { Cookie: `sid=${sid}` }
    assert.equal((await t.post('/auth/password', { current: 'wrong', next: 'a long password' }, h)).status, 401)
    assert.equal((await t.post('/auth/password', { current: 'admin', next: 'short' }, h)).status, 400)
    assert.equal((await t.post('/auth/password', { current: 'admin', next: 'admin' }, h)).status, 400)
    const ok = await t.post('/auth/password', { current: 'admin', next: 'a long password' }, h)
    assert.equal((await ok.json()).user.mustChangePassword, false)
    assert.equal((await t.login('admin', 'admin')).status, 401)
    assert.equal((await t.login('admin', 'a long password')).status, 200)
  })

  test('changing the password signs out the other sessions', async () => {
    const t = await start()
    const first = cookieOf(await t.login())
    const second = cookieOf(await t.login())
    await t.post('/auth/password', { current: 'admin', next: 'a long password' }, { Cookie: `sid=${second}` })
    assert.equal((await fetch(`${t.base}/auth/me`, { headers: { Cookie: `sid=${first}` } })).status, 401)
    assert.equal((await fetch(`${t.base}/auth/me`, { headers: { Cookie: `sid=${second}` } })).status, 200)
  })

  test('the login route rejects a malformed body and an oversize one', async () => {
    const t = await start()
    assert.equal((await t.login(undefined, undefined, {})).status, 200) // control: defaults are valid
    assert.equal((await t.post('/auth/login', { username: 1, password: 2 })).status, 400)
    const big = await fetch(`${t.base}/auth/login`, { method: 'POST', body: 'x'.repeat(10000) })
    assert.equal(big.status, 413)
  })

  test('a disallowed Origin is still refused before any auth work', async () => {
    const t = await start()
    const res = await t.post('/auth/login', { username: 'admin', password: 'admin' }, { Origin: 'http://evil.example' })
    assert.equal(res.status, 403)
  })
})
