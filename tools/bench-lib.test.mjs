import assert from 'node:assert/strict'
import { test } from 'node:test'
import { breakEvenGb, cacheStatus, monthlyCost, percentile, summarizeTarget } from './bench-lib.mjs'

const RATES = {
  s3: { storagePerGbMonth: 0.02, getPer1k: 0.0004, egressPerGb: 0.1, freeEgressGbPerMonth: 0 },
  cdn: { egressPerGb: 0.05, cacheFillPerGb: 0.01, lookupPer10k: 0.01 },
}

test('percentile uses nearest rank', () => {
  const xs = [5, 1, 3, 2, 4, 6, 7, 8, 9, 10]
  assert.equal(percentile(xs, 50), 5)
  assert.equal(percentile(xs, 95), 10)
  assert.equal(percentile(xs, 0), 1)
  assert.ok(Number.isNaN(percentile([], 50)))
})

test('cacheStatus reads explicit headers, then age', () => {
  assert.equal(cacheStatus({ 'x-cache': 'Hit from cloudfront' }), 'HIT')
  assert.equal(cacheStatus({ 'x-cache': 'MISS' }), 'MISS')
  assert.equal(cacheStatus({ age: '12' }), 'HIT')
  assert.equal(cacheStatus({ age: '0' }), 'unknown')
  assert.equal(cacheStatus({}), 'unknown')
})

test('summarizeTarget separates errors, counts segment throughput and hit ratio', () => {
  const s = summarizeTarget([
    { kind: 'manifest', ttfbMs: 10, totalMs: 12, bytes: 500, status: 200, cache: 'unknown' },
    { kind: 'segment', ttfbMs: 20, totalMs: 1000, bytes: 1_000_000, status: 200, cache: 'MISS' },
    { kind: 'segment', ttfbMs: 5, totalMs: 1000, bytes: 1_000_000, status: 200, cache: 'HIT' },
    { kind: 'segment', ttfbMs: 1, totalMs: 1, bytes: 0, status: 503, cache: 'unknown' },
  ])
  assert.equal(s.requests, 4)
  assert.equal(s.errors, 1)
  assert.equal(s.hitRatio, 0.5)
  assert.equal(s.segmentMbps, 8) // 2 MB over 2 s
  assert.equal(s.ttfbMs.n, 3)
})

test('direct cost is egress plus requests plus storage', () => {
  const c = monthlyCost(RATES, { gbPerMonth: 100, requestsPerMonth: 10000, hitRatio: 1, storageGb: 10 })
  assert.ok(Math.abs(c.direct - (10 + 0.004 + 0.2)) < 1e-9)
})

test('cdn cost adds origin fill for the miss share', () => {
  const c = monthlyCost(RATES, { gbPerMonth: 100, requestsPerMonth: 10000, hitRatio: 0.9 })
  // egress 5 + fill 10 GB * 0.01 + lookups 0.01 + S3 egress for 10 GB 1.0 + S3 GETs for 1000 reqs 0.0004
  assert.ok(Math.abs(c.cdn - (5 + 0.1 + 0.01 + 1 + 0.0004)) < 1e-9)
})

test('free S3 egress makes direct cheaper at small volumes', () => {
  const rates = { ...RATES, s3: { ...RATES.s3, freeEgressGbPerMonth: 100 } }
  const c = monthlyCost(rates, { gbPerMonth: 50, requestsPerMonth: 1000, hitRatio: 0.9 })
  assert.ok(c.delta > 0)
})

test('break-even is found where the CDN overtakes, and null when it never does', () => {
  // 100 GB/month of free S3 egress delays the point at which the CDN becomes cheaper.
  const rates = { ...RATES, s3: { ...RATES.s3, freeEgressGbPerMonth: 100 } }
  const params = { gbPerMonth: 100, requestsPerMonth: 100000, hitRatio: 0.95 }
  const gb = breakEvenGb(rates, params)
  assert.ok(gb > 100, `break-even ${gb}`)
  const at = (g) => monthlyCost(rates, { ...params, gbPerMonth: g, requestsPerMonth: params.requestsPerMonth * (g / 100) })
  assert.ok(at(gb * 0.9).delta > 0)
  assert.ok(at(gb * 1.1).delta < 0)
  // A CDN that is strictly more expensive per GB never wins.
  const worse = { ...RATES, cdn: { ...RATES.cdn, egressPerGb: 0.5 } }
  assert.equal(breakEvenGb(worse, params), null)
})
