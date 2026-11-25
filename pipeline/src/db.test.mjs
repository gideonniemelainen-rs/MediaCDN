import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { hashToken, newToken } from './auth.mjs'
import { migrate } from './db/migrate.mjs'
import { createSessions } from './db/sessions.mjs'
import { SKIP, openTestDb } from './db/testing.mjs'
import { createUsers, seedAdmin } from './db/users.mjs'

const db = await openTestDb()

describe('database', { skip: !db && SKIP }, () => {
  after(() => db?.close())
  const users = db && createUsers(db.pool)
  const sessions = db && createSessions(db.pool)

  test('migrations are recorded, and running them again changes nothing', async () => {
    const { rows } = await db.pool.query('SELECT version FROM schema_migrations')
    assert.deepEqual(rows.map((r) => r.version), ['001', '002'])
    assert.deepEqual(await migrate(db.pool), [])
  })

  test('two migrators at once do not clash', async () => {
    const fresh = await openTestDb({ migrated: false })
    try {
      const results = await Promise.all([migrate(fresh.pool), migrate(fresh.pool), migrate(fresh.pool)])
      assert.deepEqual(results.flat().sort(), ['001', '002'], 'each migration applied exactly once')
    } finally {
      await fresh.close()
    }
  })

  test('creates every table the plan names', async () => {
    const { rows } = await db.pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [db.schema])
    const names = rows.map((r) => r.table_name)
    for (const t of ['users', 'sessions', 'uploads', 'upload_stages', 'benchmark_runs', 'benchmark_sessions', 'artifacts', 'settings', 'app_settings'])
      assert.ok(names.includes(t), t)
  })

  test('seeds admin/admin once, flagged for a password change', async () => {
    assert.equal(await seedAdmin(users), true)
    assert.equal(await seedAdmin(users), false)
    const admin = await users.findByName('ADMIN') // case-insensitive
    assert.equal(admin.role, 'admin')
    assert.equal(admin.mustChangePassword, true)
    assert.equal(await users.count(), 1)
  })

  test('usernames are unique ignoring case', async () => {
    await users.create({ username: 'Pat', password: 'password1' })
    await assert.rejects(users.create({ username: 'pat', password: 'password2' }), /users_username_key/)
  })

  test('setting a password clears the change flag', async () => {
    const admin = await users.findByName('admin')
    await users.setPassword(admin.id, 'a better one')
    assert.equal((await users.findById(admin.id)).mustChangePassword, false)
  })

  test('a session works until it expires, and touching it slides the expiry', async () => {
    const u = await users.findByName('pat')
    const token = newToken()
    await sessions.create(u.id, token)
    assert.equal(await sessions.touch(token), u.id)
    assert.equal(await sessions.touch('not-a-token'), undefined)
    await db.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [hashToken(token)])
    assert.equal(await sessions.touch(token), undefined, 'expired')
    await sessions.purgeExpired()
    assert.equal((await db.pool.query('SELECT count(*) AS n FROM sessions WHERE token_hash = $1', [hashToken(token)])).rows[0].n, '0')
  })

  test('destroyOthers keeps only the session in use', async () => {
    const u = await users.findByName('pat')
    const [a, b] = [newToken(), newToken()]
    await sessions.create(u.id, a)
    await sessions.create(u.id, b)
    await sessions.destroyOthers(u.id, a)
    assert.equal(await sessions.touch(a), u.id)
    assert.equal(await sessions.touch(b), undefined)
  })

  test('benchmark children cascade with their run', async () => {
    const u = await users.findByName('pat')
    const { rows } = await db.pool.query(
      `INSERT INTO benchmark_runs (user_id, started_at, ended_at) VALUES ($1, now(), now()) RETURNING id`, [u.id])
    const id = rows[0].id
    await db.pool.query(`INSERT INTO benchmark_sessions (run_id, slot, stream_id, delivery) VALUES ($1, 0, 'bbb-hls', 'local')`, [id])
    await db.pool.query(`DELETE FROM benchmark_runs WHERE id = $1`, [id])
    assert.equal((await db.pool.query('SELECT count(*) AS n FROM benchmark_sessions')).rows[0].n, '0')
  })
})
