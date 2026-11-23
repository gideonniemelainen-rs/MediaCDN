import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COOKIE, createRateLimiter, hashPassword, hashToken, newToken, parseCookies, tokenFrom, verifyPassword } from './auth.mjs'

test('a password verifies against its own hash and nothing else', async () => {
  const h = await hashPassword('correct horse')
  assert.match(h, /^scrypt\$16384\$8\$1\$/)
  assert.equal(await verifyPassword('correct horse', h), true)
  assert.equal(await verifyPassword('wrong', h), false)
  assert.notEqual(h, await hashPassword('correct horse'), 'salted')
})

test('a malformed stored hash fails closed', async () => {
  assert.equal(await verifyPassword('x', 'plaintext'), false)
  assert.equal(await verifyPassword('x', ''), false)
})

test('tokens are random, and only their hash is stored', () => {
  const a = newToken()
  assert.notEqual(a, newToken())
  assert.match(a, /^[A-Za-z0-9_-]{43}$/)
  assert.match(hashToken(a), /^[0-9a-f]{64}$/)
})

test('the token comes from the bearer header first, then the cookie', () => {
  assert.equal(tokenFrom({ authorization: 'Bearer abc' }), 'abc')
  assert.equal(tokenFrom({ cookie: `x=1; ${COOKIE}=def` }), 'def')
  assert.equal(tokenFrom({ authorization: 'Bearer abc', cookie: `${COOKIE}=def` }), 'abc')
  assert.equal(tokenFrom({ authorization: 'Basic abc' }), undefined)
  assert.deepEqual(parseCookies('a=1; b=2=3'), { a: '1', b: '2=3' })
})

test('the rate limiter blocks after the limit, per key, and recovers', () => {
  let t = 0
  const l = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t })
  for (let i = 0; i < 3; i++) l.fail('a')
  assert.equal(l.blocked('a'), true)
  assert.equal(l.blocked('b'), false)
  t = 1001
  assert.equal(l.blocked('a'), false, 'window passed')
  l.fail('a')
  l.reset('a')
  assert.equal(l.blocked('a'), false)
})
