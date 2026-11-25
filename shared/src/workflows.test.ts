import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORKFLOWS, WORKFLOW_IDS, isDryRun, isWorkflowId, stagesFor, validateParams } from './workflows.ts'

const ok = (id: Parameters<typeof validateParams>[0], input: unknown, defaults?: Parameters<typeof validateParams>[2]) => {
  const r = validateParams(id, input, defaults)
  assert.ok(r.ok, JSON.stringify(r))
  return r.params
}
const errors = (id: Parameters<typeof validateParams>[0], input: unknown, defaults?: Parameters<typeof validateParams>[2]) => {
  const r = validateParams(id, input, defaults)
  assert.ok(!r.ok, 'expected errors')
  return r.errors
}

test('every workflow is well formed', () => {
  assert.deepEqual(Object.keys(WORKFLOWS).sort(), [...WORKFLOW_IDS].sort())
  for (const id of WORKFLOW_IDS) {
    const wf = WORKFLOWS[id]
    assert.equal(wf.id, id)
    const keys = wf.params.map((p) => p.key)
    assert.equal(new Set(keys).size, keys.length, `${id}: parameter keys are unique`)
    for (const list of [wf.stages, wf.dryRunStages ?? []]) {
      const ids = list.map((s) => s.id)
      assert.equal(new Set(ids).size, ids.length, `${id}: stage ids are unique`)
      for (const s of list) for (const n of s.needs) assert.ok(ids.includes(n), `${id}: ${s.id} needs unknown ${n}`)
    }
    if (wf.kind === 'run') assert.ok(wf.stages.length > 0, `${id}: a run has stages`)
    else assert.ok(wf.guide?.length && !wf.params.length && !wf.stages.length, `${id}: a guide has steps and nothing to run`)
    assert.equal(wf.safety === 'dry-run-then-confirm', !!wf.dryRunStages, `${id}: gated exactly when it has dry run stages`)
    if (wf.safety === 'dry-run-then-confirm') assert.ok(keys.includes('confirm'), `${id}: a gated workflow takes confirm`)
  }
})

test('the ids that reach the server are recognised exactly', () => {
  assert.ok(isWorkflowId('bench'))
  for (const bad of ['', 'toString', '__proto__', 'constructor', 'BENCH', undefined, 3]) assert.ok(!isWorkflowId(bad), String(bad))
})

test('defaults fill in what is absent, and the caller supplies the rest', () => {
  assert.deepEqual(ok('package-title', { id: 'bbb' }), { id: 'bbb', quick: false })
  assert.deepEqual(ok('package-title', { id: 'bbb', quick: true }), { id: 'bbb', quick: true })
  assert.deepEqual(ok('upload-s3', { slug: 'bbb' }, { bucket: 'my-bucket' }), { slug: 'bbb', bucket: 'my-bucket' })
  assert.deepEqual(errors('upload-s3', { slug: 'bbb' }), { bucket: 'is required' })
  assert.equal(ok('upload-s3', { slug: 'bbb', bucket: 'given-one' }, { bucket: 'env-one' }).bucket, 'given-one', 'what is sent wins over the default')
  assert.deepEqual(errors('package-title', {}), { id: 'is required' })
})

test('slugs are the title ids and nothing that reaches a path or a shell', () => {
  for (const bad of ['../etc', 'a/b', 'A', 'a b', '-a', '', 'a;rm -rf /', '$(id)', 'a'.repeat(65), 'a\nb']) {
    assert.ok('id' in errors('package-title', { id: bad }) || bad === '', JSON.stringify(bad))
  }
  assert.equal(ok('package-title', { id: 'ugc-my-clip-2' }).id, 'ugc-my-clip-2')
  assert.equal(String(ok('package-title', { id: 'a'.repeat(64) }).id).length, 64)
})

test('unknown parameters and wrong types are refused, hostile keys included', () => {
  assert.deepEqual(errors('package-title', { id: 'bbb', rm: 'yes' }), { rm: 'unknown parameter' })
  assert.deepEqual(Object.keys(errors('package-title', JSON.parse('{"id":"bbb","__proto__":{"x":1},"constructor":2}'))).sort(), ['__proto__', 'constructor'])
  assert.ok('quick' in errors('package-title', { id: 'bbb', quick: 'yes' }))
  assert.ok('' in errors('package-title', null))
  assert.ok('' in errors('package-title', []))
  assert.ok('' in errors('package-title', 'bbb'))
})

test('a guide cannot be run', () => {
  for (const id of ['shape-network', 'lab-certs', 'chrome-lab'] as const) assert.match(errors(id, {})[''], /guide/)
})

test('lists are bounded and every item is checked', () => {
  assert.deepEqual(ok('fetch-sources', {}), {})
  assert.deepEqual(ok('fetch-sources', { ids: ['bbb', 'sintel'] }).ids, ['bbb', 'sintel'])
  assert.match(errors('fetch-sources', { ids: ['bbb', '../x'] }).ids, /item 2/)
  assert.ok('ids' in errors('fetch-sources', { ids: 'bbb' }))
  assert.ok('ids' in errors('fetch-sources', { ids: Array.from({ length: 51 }, () => 'a') }))
})

test('benchmark targets are name=url, with the url cleaned and the name constrained', () => {
  const p = ok('bench', { targets: ['local=http://localhost:8788/', 's3=https://b.s3.amazonaws.com/media'] })
  assert.deepEqual(p.targets, ['local=http://localhost:8788', 's3=https://b.s3.amazonaws.com/media'])
  assert.deepEqual([p.slug, p.rounds, p.segments], ['bbb', 5, 6])
  for (const bad of ['nourl', '=http://x', 'a=ftp://x', 'a=http://u:p@x', 'a=http://x?q=1', 'A=http://x', 'a b=http://x', 5]) {
    assert.ok('targets' in errors('bench', { targets: [bad] }), String(bad))
  }
  assert.ok('targets' in errors('bench', { targets: [] }), 'at least one')
  assert.ok('targets' in errors('bench', {}), 'required')
  assert.ok('rounds' in errors('bench', { targets: ['a=http://x'], rounds: 0 }))
  assert.ok('segments' in errors('bench', { targets: ['a=http://x'], segments: 1.5 }))
})

test('bucket names and confirm ids are constrained', () => {
  for (const bad of ['UPPER', 'a', '-x-', 'a_b', 'a/b', 'a b', 'x'.repeat(64)]) assert.ok('bucket' in errors('rebuild-s3-index', { bucket: bad }), bad)
  assert.equal(ok('rebuild-s3-index', { bucket: 'my.bucket-1' }).bucket, 'my.bucket-1')
  assert.ok('confirm' in errors('rebuild-s3-index', { bucket: 'my-bucket', confirm: '../x' }))
})

test('a gated workflow is a dry run until it confirms one', () => {
  const dry = ok('upload-s3', { slug: 'bbb', bucket: 'my-bucket' })
  assert.ok(isDryRun('upload-s3', dry))
  assert.deepEqual(stagesFor('upload-s3', dry).map((s) => s.id), ['dry-run'])
  const real = ok('upload-s3', { slug: 'bbb', bucket: 'my-bucket', confirm: 'run_1' })
  assert.ok(!isDryRun('upload-s3', real))
  assert.deepEqual(stagesFor('upload-s3', real).map((s) => s.id), ['upload', 'index'])
  assert.ok(!isDryRun('package-title', ok('package-title', { id: 'bbb' })), 'a safe workflow has no dry run')
  assert.deepEqual(stagesFor('package-title', { id: 'bbb' }).map((s) => s.id), ['probe', 'package', 'verify'])
})
