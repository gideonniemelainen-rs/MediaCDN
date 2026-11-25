import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { RevisionConflict, SettingsInvalid, createSettings } from './db/settings.mjs'
import { SKIP, openTestDb } from './db/testing.mjs'
import { createUsers } from './db/users.mjs'

const db = await openTestDb()

describe('application settings', { skip: !db && SKIP }, () => {
  after(() => db?.close())
  const repo = db && createSettings(db.pool)

  test('an empty store has no overrides and is at revision 0', async () => {
    assert.deepEqual(await repo.all(), { revision: 0, overrides: {}, revisions: {} })
    assert.deepEqual(await repo.get('packaging'), { value: {}, revision: 0 })
  })

  test('a group is stored in its normalised form, and revisions rise across groups', async () => {
    const a = await repo.set('deliveries', { 's3-near.base': '  https://near.example.com/ ', 'local.enabled': false })
    assert.deepEqual(a.value, { 's3-near.base': 'https://near.example.com', 'local.enabled': false })
    const b = await repo.set('packaging', { packager: 'shaka' })
    assert.ok(b.revision > a.revision, 'one sequence across every group')
    const all = await repo.all()
    assert.equal(all.revision, b.revision, 'the document revision is the highest')
    assert.deepEqual(all.overrides, { deliveries: a.value, packaging: { packager: 'shaka' } })
    assert.deepEqual(all.revisions, { deliveries: a.revision, packaging: b.revision })
  })

  test('set replaces the group, it does not merge', async () => {
    await repo.set('player', { adsEnabled: false, uncappedDefault: true })
    const r = await repo.set('player', { adsEnabled: true })
    assert.deepEqual(r.value, { adsEnabled: true })
    assert.deepEqual((await repo.get('player')).value, { adsEnabled: true })
  })

  test('an unknown group, an unknown field and a bad value are refused, and nothing is stored', async () => {
    const before = await repo.all()
    await assert.rejects(repo.set('nope', {}), (e) => e instanceof SettingsInvalid && e.status === 400 && /unknown settings group/.test(e.message))
    await assert.rejects(repo.set('origin', { liveWindow: 99, mystery: 1 }), (e) => e instanceof SettingsInvalid && e.errors.liveWindow && e.errors.mystery === 'unknown setting')
    await assert.rejects(repo.set('packaging', { image: '--privileged' }), SettingsInvalid)
    await assert.rejects(repo.unset('origin', 'nope'), SettingsInvalid)
    await assert.rejects(repo.get('nope'), SettingsInvalid)
    assert.deepEqual(await repo.all(), before)
  })

  test('with ifRevision a write only lands on the revision the caller read', async () => {
    const first = await repo.set('origin', { liveWindow: 6 }, { ifRevision: 0 })
    await assert.rejects(repo.set('origin', { liveWindow: 7 }, { ifRevision: 0 }), (e) => e instanceof RevisionConflict && e.status === 409 && e.actual === first.revision)
    const second = await repo.set('origin', { liveWindow: 7 }, { ifRevision: first.revision })
    assert.ok(second.revision > first.revision)
    assert.equal((await repo.get('origin')).value.liveWindow, 7)
  })

  test('a group that was never set can only be written against revision 0', async () => {
    await assert.rejects(repo.set('player', { adsEnabled: true }, { ifRevision: 0 }), RevisionConflict, 'player already exists from an earlier test')
    const fresh = await openTestDb()
    try {
      const r = createSettings(fresh.pool)
      await assert.rejects(r.set('origin', { liveWindow: 5 }, { ifRevision: 3 }), (e) => e instanceof RevisionConflict && e.actual === 0)
      assert.deepEqual(await r.all(), { revision: 0, overrides: {}, revisions: {} }, 'the refused write left nothing behind')
      assert.ok((await r.set('origin', { liveWindow: 5 }, { ifRevision: 0 })).revision > 0)
    } finally {
      await fresh.close()
    }
  })

  test('two writers holding the same revision: exactly one wins', async () => {
    const { revision } = await repo.get('origin')
    const results = await Promise.allSettled([
      repo.set('origin', { liveWindow: 11 }, { ifRevision: revision }),
      repo.set('origin', { liveWindow: 12 }, { ifRevision: revision }),
      repo.set('origin', { liveWindow: 13 }, { ifRevision: revision }),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    for (const r of results.filter((x) => x.status === 'rejected')) assert.ok(r.reason instanceof RevisionConflict)
  })

  test('unset resets one field, keeps the others, and bumps the revision', async () => {
    await repo.set('deliveries', { 'local.base': 'http://localhost:9000', 'local.enabled': false })
    const before = await repo.get('deliveries')
    const after = await repo.unset('deliveries', 'local.base')
    assert.deepEqual(after.value, { 'local.enabled': false })
    assert.ok(after.revision > before.revision)
  })

  test('unsetting a field that is not overridden changes nothing and bumps nothing', async () => {
    const before = await repo.get('deliveries')
    const after = await repo.unset('deliveries', 's3-far.base')
    assert.deepEqual(after, before)
    assert.deepEqual(await repo.get('deliveries'), before)
  })

  test('unset honours ifRevision too', async () => {
    const { revision } = await repo.get('deliveries')
    await assert.rejects(repo.unset('deliveries', 'local.enabled', { ifRevision: revision - 1 }), RevisionConflict)
    assert.deepEqual((await repo.unset('deliveries', 'local.enabled', { ifRevision: revision })).value, {})
  })

  test('emptying a group keeps its row, so the document revision never goes down', async () => {
    const before = (await repo.all()).revision
    await repo.set('player', {})
    const after = await repo.all()
    assert.ok(after.revision >= before)
    assert.deepEqual(after.overrides.player, {})
    assert.ok('player' in after.revisions)
  })

  test('records who changed a group, and survives that user being deleted', async () => {
    const users = createUsers(db.pool)
    const admin = await users.create({ username: 'settings-admin', password: 'a-long-enough-password', role: 'admin' })
    await repo.set('origin', { liveEnabled: false }, { userId: admin.id })
    const who = () => db.pool.query("SELECT updated_by FROM app_settings WHERE group_name = 'origin'").then((r) => r.rows[0].updated_by)
    assert.equal(await who(), admin.id)
    await db.pool.query('DELETE FROM users WHERE id = $1', [admin.id])
    assert.equal(await who(), null)
    assert.equal((await repo.get('origin')).value.liveEnabled, false, 'the setting itself stays')
  })
})
