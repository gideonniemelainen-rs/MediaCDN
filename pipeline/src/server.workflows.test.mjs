import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { WORKFLOW_IDS } from '../../shared/src/workflows.ts'
import { createRateLimiter } from './auth.mjs'
import { createRuns } from './db/runs.mjs'
import { createSessions } from './db/sessions.mjs'
import { SKIP, openTestDb } from './db/testing.mjs'
import { createUsers, seedAdmin } from './db/users.mjs'
import { createPipelineServer } from './server.mjs'
import { StageError } from './run.mjs'

const db = await openTestDb()
const quick = async () => ({ summary: 'ok' })
const steps = { probe: quick, validate: quick, normalise: quick, ladder: quick, package: quick, verify: quick, publish: quick }

// Stand-in workflows: the behaviour is tested in workflows/workflows.test.mjs, here it is the API around them.
const impl = {
  bench: { steps: () => ({ run: async () => ({ summary: 'ran' }), report: async (ctx) => { (await import('node:fs/promises')).writeFile(join(ctx.dir, 'report.json'), '{"ok":true}'); return { summary: 'written' } } }) },
  'upload-s3': { steps: ({ dryRun, params }) => (dryRun ? { 'dry-run': async () => ({ summary: `would upload to ${params.bucket}` }) } : { upload: quick, index: quick }) },
  'package-title': { steps: () => ({ probe: async () => { throw new StageError('E_NO_SOURCE', 'no source') }, package: quick, verify: quick }) },
}

describe('workflow API', { skip: !db && SKIP }, () => {
  const cleanup = []
  after(async () => {
    for (const f of cleanup) await f()
    await db?.close()
  })

  async function start({ withWorkflows = true, s3Bucket, workflows = impl } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-workflows-'))
    const users = createUsers(db.pool)
    await db.pool.query('TRUNCATE users CASCADE')
    await seedAdmin(users)
    await users.create({ username: 'bob', password: 'a-long-enough-password', role: 'user' })
    const auth = { users, sessions: createSessions(db.pool), limiter: createRateLimiter({ limit: 100 }), dbStatus: async () => null }
    const history = { runs: createRuns(db.pool) }
    const { server, runs } = await createPipelineServer({
      work: join(root, 'work'), origin: join(root, 'origin'), profile: { limits: { maxFileBytes: 1000 } }, steps, auth,
      history: { uploads: { upsert: async () => true, list: async () => ({ uploads: [], next: null }), get: async () => undefined }, ...history },
      ...(withWorkflows && { workflows, ...(s3Bucket && { s3Bucket }) }),
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
    const call = (method, path, { headers = admin, body, raw } = {}) =>
      fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body !== undefined && { body: raw ? body : JSON.stringify(body) }) })
    const post = (id, body, headers) => call('POST', `/workflows/${id}/runs`, { body, headers })
    const settle = async () => { await runs.idle() }
    return { base, admin, bob, call, post, runs, settle, history }
  }

  test('signed out is 401 and a non-admin is 403 on every route', async () => {
    const t = await start()
    const run = await (await t.post('bench', { targets: ['a=http://x'] })).json()
    for (const [method, path] of [['GET', '/workflows'], ['POST', '/workflows/bench/runs'], ['GET', '/runs'], ['GET', `/runs/${run.id}`], ['GET', `/runs/${run.id}/events`], ['GET', `/runs/${run.id}/files/report.json`]]) {
      assert.equal((await t.call(method, path, { headers: {}, body: method === 'POST' ? {} : undefined })).status, 401, `${method} ${path} signed out`)
      assert.equal((await t.call(method, path, { headers: t.bob, body: method === 'POST' ? {} : undefined })).status, 403, `${method} ${path} as a user`)
    }
  })

  test('a server with no workflows has no such routes', async () => {
    const t = await start({ withWorkflows: false })
    assert.equal((await t.call('GET', '/workflows')).status, 404)
    assert.equal((await t.call('GET', '/runs')).status, 404)
  })

  test('the catalog lists every workflow as JSON, marks what this server can run, and gives the bucket default', async () => {
    const t = await start({ s3Bucket: 'env-bucket' })
    const body = await (await t.call('GET', '/workflows')).json()
    assert.deepEqual(body.workflows.map((w) => w.id), [...WORKFLOW_IDS])
    assert.deepEqual(Object.fromEntries(body.workflows.map((w) => [w.id, w.runnable])), {
      'probe-sources': false, 'fetch-sources': false, 'package-title': true, 'make-ads': false, 'smoke-origin': false, bench: true,
      'upload-s3': true, 'rebuild-s3-index': false, 'shape-network': false, 'lab-certs': false, 'chrome-lab': false,
    })
    assert.equal(body.defaults.bucket, 'env-bucket')
    const slug = body.workflows.find((w) => w.id === 'upload-s3').params.find((p) => p.key === 'slug')
    assert.equal(typeof slug.type.pattern, 'string')
    assert.ok(body.workflows.find((w) => w.id === 'shape-network').guide.length > 0)
    assert.equal((await t.call('POST', '/workflows')).status, 405)
  })

  test('parameters are validated: field errors come back as 400, hostile or unknown ones included', async () => {
    const t = await start()
    const r = await t.post('package-title', { id: '../../etc/passwd', quick: 'yes', extra: 1 })
    assert.equal(r.status, 400)
    const body = await r.json()
    assert.deepEqual(Object.keys(body.errors).sort(), ['extra', 'id', 'quick'])
    assert.equal((await t.post('bench', { targets: [] })).status, 400)
    const broken = await t.call('POST', '/workflows/bench/runs', { body: '{nope', raw: true })
    assert.equal(broken.status, 400)
    const huge = await t.call('POST', '/workflows/bench/runs', { body: JSON.stringify({ targets: ['a=http://x'], pad: 'x'.repeat(20000) }), raw: true })
    assert.equal(huge.status, 413)
    assert.equal((await t.runs.list()).length, 0, 'nothing was started')
  })

  test('an unknown workflow is 404, a guide is refused with its reason, and one this server lacks is 404', async () => {
    const t = await start()
    for (const id of ['nope', '__proto__', 'toString', 'a'.repeat(50)]) assert.equal((await t.post(id, {})).status, 404, id)
    const guide = await t.post('shape-network', {})
    assert.equal(guide.status, 400)
    assert.match((await guide.json()).errors[''], /guide/)
    assert.equal((await t.post('make-ads', {})).status, 404, 'valid parameters, but no implementation here')
    assert.equal((await t.call('GET', '/workflows/bench/runs')).status, 405)
  })

  test('a run starts, finishes, shows no owner, is recorded in history and keeps what it wrote', async () => {
    const t = await start()
    const started = await t.post('bench', { targets: ['local=http://localhost:8788'] })
    assert.equal(started.status, 201)
    const run = await started.json()
    assert.match(run.id, /^[0-9a-f]{8}$/)
    assert.equal(run.meta.userId, undefined)
    assert.deepEqual(run.stages.map((s) => s.id), ['run', 'report'])
    assert.deepEqual(run.meta.params, { targets: ['local=http://localhost:8788'], slug: 'bbb', rounds: 5, segments: 6 }, 'defaults are filled in')
    await t.settle()
    const done = await (await t.call('GET', `/runs/${run.id}`)).json()
    assert.equal(done.status, 'success')
    const file = await t.call('GET', `/runs/${run.id}/files/report.json`)
    assert.equal(file.status, 200)
    assert.deepEqual(await file.json(), { ok: true })
    const list = await (await t.call('GET', '/runs')).json()
    assert.equal(list.runs[0].id, run.id)
    assert.equal(list.runs[0].workflow, 'bench')
    assert.equal(list.runs[0].owner, 'admin')
    assert.equal((await (await t.call('GET', '/runs?workflow=upload-s3')).json()).runs.length, 0)
  })

  test('a failing run is a successful request: the failure is in the run', async () => {
    const t = await start()
    const run = await (await t.post('package-title', { id: 'demo' })).json()
    await t.settle()
    const done = await (await t.call('GET', `/runs/${run.id}`)).json()
    assert.equal(done.status, 'failed')
    assert.equal(done.stages[0].result.code, 'E_NO_SOURCE')
    assert.equal((await (await t.call('GET', '/runs')).json()).runs[0].errorCode, 'E_NO_SOURCE')
  })

  test('the events stream sends the snapshot, each change, and then closes with done', async () => {
    const t = await start()
    const run = await (await t.post('bench', { targets: ['a=http://x'] })).json()
    const res = await t.call('GET', `/runs/${run.id}/events`)
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    const text = await res.text()
    const events = text.split('\n\n').filter((e) => e.startsWith('data: {"id"')).map((e) => JSON.parse(e.slice(6)))
    assert.ok(events.length >= 1, 'at least the current snapshot')
    assert.equal(events.at(-1).status, 'success')
    assert.ok(events.every((e) => e.meta.userId === undefined))
    assert.match(text, /event: done/)
  })

  test('run files are only what a run wrote, by a plain name', async () => {
    const t = await start()
    const run = await (await t.post('bench', { targets: ['a=http://x'] })).json()
    await t.settle()
    for (const name of ['nothing.json', '..%2f..%2fjobs%2f' + run.id + '.json', '%2e%2e%2freport.json', 'report.txt', '.hidden.json', 'REPORT.json']) {
      assert.equal((await t.call('GET', `/runs/${run.id}/files/${name}`)).status, 404, name)
    }
    for (const id of ['zzzzzzzz', '1234', '../x', run.id.toUpperCase(), '00000000']) assert.equal((await t.call('GET', `/runs/${id}`)).status, 404, id)
  })

  test('the S3 gate over HTTP: no confirm is a dry run, a confirm needs a finished matching one, and it is used once', async () => {
    let release
    const held = new Promise((r) => (release = r))
    const slow = { ...impl, 'upload-s3': { steps: ({ dryRun }) => (dryRun ? { 'dry-run': async () => { await held; return { summary: 'listed' } } } : { upload: quick, index: quick }) } }
    const t = await start({ s3Bucket: 'env-bucket', workflows: slow })
    const dry = await (await t.post('upload-s3', { slug: 'bbb' })).json()
    assert.equal(dry.meta.dryRun, true)
    assert.equal(dry.meta.params.bucket, 'env-bucket', 'the bucket defaults from the server environment')
    assert.deepEqual(dry.stages.map((s) => s.id), ['dry-run'])

    const early = await t.post('upload-s3', { slug: 'bbb', confirm: dry.id })
    assert.equal(early.status, 409)
    assert.match((await early.json()).error, /not finished/)
    const unknown = await t.post('upload-s3', { slug: 'bbb', confirm: 'deadbeef' })
    assert.equal(unknown.status, 409)
    assert.match((await unknown.json()).error, /no such dry run/)

    release()
    await t.settle()
    const changed = await t.post('upload-s3', { slug: 'sintel', confirm: dry.id })
    assert.equal(changed.status, 409)
    assert.match((await changed.json()).error, /differ/)

    const real = await t.post('upload-s3', { slug: 'bbb', confirm: dry.id })
    assert.equal(real.status, 201)
    const realRun = await real.json()
    assert.equal(realRun.meta.dryRun, false)
    assert.deepEqual(realRun.stages.map((s) => s.id), ['upload', 'index'])
    const again = await t.post('upload-s3', { slug: 'bbb', confirm: dry.id })
    assert.equal(again.status, 409)
    assert.match((await again.json()).error, /already used/)
    await t.settle()
    assert.equal((await t.runs.list()).filter((r) => !r.dryRun).length, 1, 'exactly one real run')
  })

  test('without a default bucket, the bucket is required', async () => {
    const t = await start()
    const r = await t.post('upload-s3', { slug: 'bbb' })
    assert.equal(r.status, 400)
    assert.deepEqual((await r.json()).errors, { bucket: 'is required' })
  })
})
