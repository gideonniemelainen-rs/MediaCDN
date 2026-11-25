import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQueue } from './queue.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

test('tasks run one at a time, in the order added', async () => {
  const q = createQueue()
  const log = []
  const gate = deferred()
  q.add(async () => { log.push('a start'); await gate.promise; log.push('a end') })
  q.add(async () => { log.push('b') })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(log, ['a start'], 'b waits for a')
  gate.resolve()
  await q.idle()
  assert.deepEqual(log, ['a start', 'a end', 'b'])
})

test('a task that throws does not stop the ones after it', async () => {
  const q = createQueue()
  const log = []
  q.add(async () => { throw new Error('boom') })
  q.add(async () => { log.push('after') })
  await q.idle()
  assert.deepEqual(log, ['after'])
})

test('idle also waits for what is added while it waits', async () => {
  const q = createQueue()
  const log = []
  q.add(async () => { q.add(async () => { log.push('nested') }); log.push('outer') })
  await q.idle()
  assert.deepEqual(log, ['outer', 'nested'])
})

test('an empty queue is idle at once', async () => {
  await createQueue().idle()
})
