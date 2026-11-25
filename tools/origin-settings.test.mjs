import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ORIGIN_DEFAULTS, createOriginSettings } from './origin-settings.mjs'

const doc = (origin) => ({ revision: 1, overrides: origin ? { origin } : {}, revisions: {} })
const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status })

function setup(fetchFn) {
  let t = 1000
  const calls = []
  const warnings = []
  const s = createOriginSettings({
    url: 'http://api/x',
    fetchFn: async (...a) => (calls.push(a[0]), fetchFn(...a)),
    now: () => t,
    warn: (m) => warnings.push(m),
  })
  return { s, calls, warnings, advance: (ms) => (t += ms) }
}

test('before any answer the defaults apply, and overrides are laid over them', async () => {
  const a = setup(reply(doc()))
  assert.deepEqual(await a.s.get(), ORIGIN_DEFAULTS)
  assert.equal(a.calls[0], 'http://api/x/settings')
  const b = setup(reply(doc({ liveWindow: 9, liveEnabled: false })))
  assert.deepEqual(await b.s.get(), { liveEnabled: false, liveWindow: 9 })
})

test('an answer is cached for the interval, then asked for again', async () => {
  let window = 3
  const a = setup(async () => new Response(JSON.stringify(doc({ liveWindow: window }))))
  assert.equal((await a.s.get()).liveWindow, 3)
  window = 8
  a.advance(4999)
  assert.equal((await a.s.get()).liveWindow, 3)
  assert.equal(a.calls.length, 1)
  a.advance(1)
  assert.equal((await a.s.get()).liveWindow, 8)
  assert.equal(a.calls.length, 2)
})

test('concurrent requests share one fetch', async () => {
  const a = setup(reply(doc({ liveWindow: 4 })))
  const got = await Promise.all([a.s.get(), a.s.get(), a.s.get()])
  assert.equal(a.calls.length, 1)
  assert.ok(got.every((g) => g.liveWindow === 4))
})

test('when the API goes away the last values stay, with one warning', async () => {
  let up = true
  const a = setup(async () => {
    if (!up) throw new Error('connect ECONNREFUSED')
    return new Response(JSON.stringify(doc({ liveEnabled: false })))
  })
  assert.equal((await a.s.get()).liveEnabled, false)
  up = false
  a.advance(5000)
  assert.equal((await a.s.get()).liveEnabled, false, 'not reset to the default')
  a.advance(5000)
  await a.s.get()
  assert.equal(a.warnings.length, 1)
  up = true
  a.advance(5000)
  await a.s.get()
  assert.match(a.warnings[1], /reachable again/)
})

test('a failing API costs one attempt per interval, not one per request', async () => {
  const a = setup(async () => { throw new Error('down') })
  for (let i = 0; i < 5; i++) assert.deepEqual(await a.s.get(), ORIGIN_DEFAULTS)
  assert.equal(a.calls.length, 1)
  a.advance(5000)
  await a.s.get()
  assert.equal(a.calls.length, 2)
})

test('an error status or a body of the wrong shape counts as a failure', async () => {
  for (const f of [reply({}, 500), reply('nope'), reply(null)]) {
    const a = setup(f)
    assert.deepEqual(await a.s.get(), ORIGIN_DEFAULTS)
    assert.equal(a.warnings.length, 1)
  }
})

test('an invalid stored value is ignored in favour of the default', async () => {
  const a = setup(reply(doc({ liveWindow: 999, liveEnabled: 'yes' })))
  assert.deepEqual(await a.s.get(), ORIGIN_DEFAULTS)
})
