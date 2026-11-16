// Pure helpers for the delivery benchmark (tools/bench.mjs): statistics, cache-status detection and
// the cost model. No I/O, so everything is testable with fixed inputs.

/** Nearest-rank percentile of a numeric list (p in 0..100); NaN for an empty list. */
export function percentile(values, p) {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

/** HIT / MISS / unknown from whichever cache headers a delivery path exposes. */
export function cacheStatus(headers) {
  const get = (k) => headers[k] ?? headers[k.toLowerCase()]
  const xc = String(get('x-cache') ?? get('x-goog-cache-status') ?? get('cf-cache-status') ?? '').toUpperCase()
  if (xc.includes('HIT')) return 'HIT'
  if (xc.includes('MISS')) return 'MISS'
  // No explicit header: a positive Age means a shared cache served it.
  const age = Number(get('age'))
  return Number.isFinite(age) && age > 0 ? 'HIT' : 'unknown'
}

const stats = (xs) => ({
  n: xs.length,
  p50: percentile(xs, 50),
  p95: percentile(xs, 95),
  p99: percentile(xs, 99),
  mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN,
})

/**
 * Summarises one target's samples. A sample is `{ kind, ttfbMs, totalMs, bytes, status, cache }`
 * where kind is 'manifest' | 'segment'. Throughput only counts segments (manifests are too small).
 */
export function summarizeTarget(samples) {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300)
  const seg = ok.filter((s) => s.kind === 'segment')
  const bytes = ok.reduce((a, s) => a + s.bytes, 0)
  const segMs = seg.reduce((a, s) => a + s.totalMs, 0)
  const withCache = ok.filter((s) => s.cache !== 'unknown')
  return {
    requests: samples.length,
    errors: samples.length - ok.length,
    bytes,
    ttfbMs: stats(ok.map((s) => s.ttfbMs)),
    segmentMs: stats(seg.map((s) => s.totalMs)),
    segmentMbps: segMs ? (seg.reduce((a, s) => a + s.bytes, 0) * 8) / 1e6 / (segMs / 1000) : NaN,
    hitRatio: withCache.length ? withCache.filter((s) => s.cache === 'HIT').length / withCache.length : null,
  }
}

/**
 * Monthly cost of serving `gbPerMonth` GB in `requestsPerMonth` requests.
 *   direct: S3 egress + GET requests (+ storage)
 *   cdn:    CDN egress + cache lookups, plus origin fill: the (1 - hitRatio) share of bytes comes from S3
 *           (S3 -> CDN is still billed as S3 internet egress) and the same share of requests hits S3.
 * Rates come from bench/rates.json; every figure there is an estimate to be checked against current pricing.
 */
export function monthlyCost(rates, { gbPerMonth, requestsPerMonth, hitRatio, storageGb = 0 }) {
  const s3 = rates.s3
  const cdn = rates.cdn
  const freeGb = s3.freeEgressGbPerMonth ?? 0
  const s3Egress = (gb) => Math.max(0, gb - freeGb) * s3.egressPerGb
  const s3Gets = (n) => (n / 1000) * s3.getPer1k
  const storage = storageGb * s3.storagePerGbMonth

  const direct = s3Egress(gbPerMonth) + s3Gets(requestsPerMonth) + storage

  const miss = 1 - hitRatio
  const fillGb = gbPerMonth * miss
  const cdnTotal =
    gbPerMonth * cdn.egressPerGb +
    fillGb * cdn.cacheFillPerGb +
    (requestsPerMonth / 10000) * cdn.lookupPer10k +
    s3Egress(fillGb) +
    s3Gets(requestsPerMonth * miss) +
    storage
  return { direct, cdn: cdnTotal, delta: cdnTotal - direct }
}

/** Smallest monthly volume (GB) at which the CDN is cheaper, or null if it never is within `maxGb`. */
export function breakEvenGb(rates, params, maxGb = 1e6) {
  const diff = (gb) => {
    const ratio = gb / params.gbPerMonth
    const c = monthlyCost(rates, { ...params, gbPerMonth: gb, requestsPerMonth: params.requestsPerMonth * ratio })
    return c.cdn - c.direct
  }
  if (diff(maxGb) > 0) return null
  let lo = 0
  let hi = maxGb
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (diff(mid) > 0) lo = mid
    else hi = mid
  }
  return hi
}
