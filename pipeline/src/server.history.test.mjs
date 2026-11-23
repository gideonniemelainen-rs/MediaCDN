import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { createRateLimiter } from './auth.mjs'
import { createSessions } from './db/sessions.mjs'
import { SKIP, openTestDb } from './db/testing.mjs'
import { createUploads } from './db/uploads.mjs'
import { createUsers } from './db/users.mjs'
import { createJobManager } from './jobs.mjs'
import { createPipelineServer } from './server.mjs'
import { finishStage, newJob, startStage } from './stages.mjs'

const db = await openTestDb()
const quick = async () => ({ summary: 'ok' })
const steps = { probe: quick, validate: quick, normalise: quick, package: quick, verify: quick, publish: quick }

describe('server history and per-user access', { skip: !db && SKIP }, () => {
  const cleanup = []
  after(async () => {
    for (const f of cleanup) await f()
    await db?.close()
  })

  async function start({ historyOverride, seedWork } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-history-'))
    const work = join(root, 'work')
    if (seedWork) await seedWork(work)
    await db.pool.query('TRUNCATE users CASCADE')
    const users = createUsers(db.pool)
    const admin = await users.create({ username: 'admin', password: 'adminpass1', role: 'admin' })
    await users.create({ username: 'pat', password: 'patpass12' })
    await users.create({ username: 'sam', password: 'sampass12' })
    const uploads = createUploads(db.pool, { fallbackUserId: async () => admin.id })
    const auth = { users, sessions: createSessions(db.pool), limiter: createRateLimiter({ limit: 50 }), dbStatus: async () => null }
    const { server, manager } = await createPipelineServer({
      work, origin: join(root, 'origin'), profile: { limits: { maxFileBytes: 1000 } }, steps, auth, history: historyOverride ?? { uploads },
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    cleanup.push(async () => { server.close(); server.closeAllConnections(); await rm(root, { recursive: true, force: true }) })
    const base = `http://127.0.0.1:${server.address().port}/api/pipeline`
    const as = {}
    for (const [name, password] of [['admin', 'adminpass1'], ['pat', 'patpass12'], ['sam', 'sampass12']]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', body: JSON.stringify({ username: name, password }) })
      as[name] = { Cookie: `sid=${/sid=([^;]+)/.exec(res.headers.get('set-cookie'))[1]}` }
    }
    const upload = async (who, name = 'clip.mov') => {
      const res = await fetch(`${base}/uploads`, { method: 'POST', headers: { ...as[who], 'X-Filename': encodeURIComponent(name) }, body: 'x'.repeat(100) })
      assert.equal(res.status, 202)
      return (await res.json()).id
    }
    const get = (who, path) => fetch(base + path, { headers: as[who] })
    return { base, as, upload, get, manager, work, uploads, users }
  }

  test('a user lists and opens only their own jobs, and an admin sees all', async () => {
    const t = await start()
    const patJob = await t.upload('pat', 'pats.mov')
    const samJob = await t.upload('sam', 'sams.mov')
    await t.manager.idle()

    assert.deepEqual((await (await t.get('pat', '/jobs')).json()).jobs.map((j) => j.id), [patJob])
    assert.deepEqual((await (await t.get('sam', '/jobs')).json()).jobs.map((j) => j.id), [samJob])
    assert.equal((await (await t.get('admin', '/jobs')).json()).jobs.length, 2)

    assert.equal((await t.get('pat', `/jobs/${patJob}`)).status, 200)
    assert.equal((await t.get('pat', `/jobs/${samJob}`)).status, 404, 'not 403: ids are not probeable')
    assert.equal((await t.get('pat', `/jobs/${samJob}/events`)).status, 404)
    assert.equal((await t.get('admin', `/jobs/${samJob}`)).status, 200)
  })

  test('the owner id is stored with the job on disk but never sent to the client', async () => {
    const t = await start()
    const id = await t.upload('pat')
    await t.manager.idle()
    const body = JSON.stringify(await (await t.get('pat', `/jobs/${id}`)).json())
    assert.equal(body.includes('userId'), false)
    const onDisk = JSON.parse(await readFile(join(t.work, 'jobs', `${id}.json`), 'utf8'))
    assert.match(onDisk.meta.userId, /^[0-9a-f-]{36}$/)
  })

  test('finished jobs show up in /uploads with their stages, per user', async () => {
    const t = await start()
    const patJob = await t.upload('pat', 'pats.mov')
    const samJob = await t.upload('sam', 'sams.mov')
    await t.manager.idle()

    const mine = await (await t.get('pat', '/uploads')).json()
    assert.deepEqual(mine.uploads.map((u) => [u.id, u.name, u.status]), [[patJob, 'pats.mov', 'success']])
    assert.equal(mine.next, null)
    const one = await (await t.get('pat', `/uploads/${patJob}`)).json()
    assert.equal(one.job.stages.length, 7)
    assert.equal((await t.get('pat', `/uploads/${samJob}`)).status, 404)
    assert.equal((await (await t.get('admin', '/uploads')).json()).uploads.length, 2)
    assert.equal((await t.get('pat', '/uploads/not-an-id')).status, 404)
  })

  test('/uploads needs a session', async () => {
    const t = await start()
    assert.equal((await fetch(`${t.base}/uploads`)).status, 401)
  })

  test('a database failure while recording never fails or stalls a job', async () => {
    const t = await start({ historyOverride: { uploads: { upsert: async () => { throw new Error('db down') }, list: async () => ({ uploads: [], next: null }), get: async () => undefined } } })
    const id = await t.upload('pat')
    await t.manager.idle()
    const job = await (await t.get('pat', `/jobs/${id}`)).json()
    assert.equal(job.status, 'success')
  })

  test('jobs already on disk are recorded at startup, once, owned by admin when they have no owner', async () => {
    const seed = async (work) => {
      await mkdir(join(work, 'jobs'), { recursive: true })
      let j = newJob({ id: 'deadbeef', now: 1_795_000_000_000, meta: { name: 'old.mov', bytes: 5, sha256: 'b'.repeat(64), outputId: 'ugc-old' } })
      j = finishStage(startStage(j, 'upload', 1_795_000_000_000), 'upload', {}, 1_795_000_000_010)
      for (const s of j.stages.slice(1)) j = finishStage(startStage(j, s.id, 1_795_000_000_020), s.id, {}, 1_795_000_000_030)
      await writeFile(join(work, 'jobs', 'deadbeef.json'), JSON.stringify(j))
    }
    const t = await start({ seedWork: seed })
    const rows = (await (await t.get('admin', '/uploads')).json()).uploads
    assert.deepEqual(rows.map((r) => [r.id, r.owner, r.status]), [['deadbeef', 'admin', 'success']])
    assert.equal((await (await t.get('pat', '/uploads')).json()).uploads.length, 0)
    assert.equal((await t.get('pat', '/jobs/deadbeef')).status, 404, 'an ownerless job is not visible to ordinary users')
    // Running the same startup again leaves one row.
    const again = createUploads(db.pool, { fallbackUserId: async () => (await t.users.findByName('admin')).id })
    const manager = await createJobManager({ work: t.work, steps })
    for (const job of manager.all()) await again.upsert(job)
    assert.equal((await db.pool.query(`SELECT count(*) AS n FROM uploads WHERE id = 'deadbeef'`)).rows[0].n, '1')
  })
})
