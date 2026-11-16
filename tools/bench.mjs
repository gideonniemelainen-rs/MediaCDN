#!/usr/bin/env node
// Delivery benchmark: fetches the same packaged title through several base URLs ("targets") and
// compares latency, throughput and cache behaviour. Runs alternate between targets each round so
// drift in network conditions hits all of them equally.
//
// Usage:
//   node tools/bench.mjs --target local=http://localhost:8788 [--target s3=https://bucket.s3.../media]
//        [--slug bbb] [--rounds 5] [--segments 6] [--rate 2800] [--out bench/report.json]
//
// A target is any host serving the layout of origin/ (master.m3u8, media_N.m3u8, chunk-*.m4s).
// Later: `s3=https://<bucket>.s3.<region>.amazonaws.com/media` and `cdn=https://<edge>/s3`.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { monthlyCost, breakEvenGb, cacheStatus, summarizeTarget } from './bench-lib.mjs'
import { parseMediaPlaylist } from './live.mjs'
import { readFile } from 'node:fs/promises'

const { values } = parseArgs({
  options: {
    target: { type: 'string', multiple: true },
    slug: { type: 'string', default: 'bbb' },
    rounds: { type: 'string', default: '5' },
    segments: { type: 'string', default: '6' },
    out: { type: 'string', default: 'bench/report.json' },
    rates: { type: 'string', default: 'bench/rates.json' },
  },
})
if (!values.target?.length) {
  console.error('need at least one --target name=baseUrl')
  process.exit(2)
}
const targets = values.target.map((t) => {
  const i = t.indexOf('=')
  if (i < 1) throw new Error(`bad target "${t}", expected name=baseUrl`)
  return { name: t.slice(0, i), base: t.slice(i + 1).replace(/\/$/, '') }
})
const ROUNDS = Number(values.rounds)
const SEGMENTS = Number(values.segments)

/** One GET: time to headers, time to last byte, bytes, cache status. */
async function timed(url, kind) {
  const t0 = performance.now()
  try {
    const res = await fetch(url, { cache: 'no-store' })
    const ttfbMs = performance.now() - t0
    const bytes = (await res.arrayBuffer()).byteLength
    const totalMs = performance.now() - t0
    return { kind, ttfbMs, totalMs, bytes, status: res.status, cache: cacheStatus(Object.fromEntries(res.headers)) }
  } catch (e) {
    return { kind, ttfbMs: 0, totalMs: performance.now() - t0, bytes: 0, status: 0, cache: 'unknown', error: String(e.cause?.code ?? e.message) }
  }
}

// Segment list for the benchmark: taken from the local packaged playlist so every target fetches
// identical objects regardless of which one is being tested.
const master = await readFile(new URL(`../origin/${values.slug}/master.m3u8`, import.meta.url), 'utf8')
const media = [...master.matchAll(/^(media_\d+\.m3u8)$/gm)].map((m) => m[1])
const rungs = await Promise.all(
  media.map(async (f) => ({ file: f, ...parseMediaPlaylist(await readFile(new URL(`../origin/${values.slug}/${f}`, import.meta.url), 'utf8')) })),
)
const rung = rungs[Math.floor(rungs.length / 2)] // a middle rung: representative, not the smallest
const segs = rung.segments.slice(0, SEGMENTS).map((s) => s.uri)
console.log(`slug=${values.slug} rung=${rung.file} segments=${segs.length} rounds=${ROUNDS} targets=${targets.map((t) => t.name).join(',')}`)

const samples = Object.fromEntries(targets.map((t) => [t.name, []]))
const perRound = Object.fromEntries(targets.map((t) => [t.name, []]))
for (let round = 0; round < ROUNDS; round++) {
  // Rotate the starting target each round so none is always first (or always cold).
  const order = targets.map((_, i) => targets[(i + round) % targets.length])
  for (const t of order) {
    const batch = []
    batch.push(await timed(`${t.base}/${values.slug}/master.m3u8`, 'manifest'))
    batch.push(await timed(`${t.base}/${values.slug}/${rung.file}`, 'manifest'))
    for (const s of segs) batch.push(await timed(`${t.base}/${values.slug}/${s}`, 'segment'))
    samples[t.name].push(...batch)
    perRound[t.name].push({ round, firstSegmentMs: batch[2].totalMs, ttfbMs: batch[2].ttfbMs, cache: batch[2].cache })
  }
  process.stdout.write('.')
}
console.log()

const results = Object.fromEntries(targets.map((t) => [t.name, summarizeTarget(samples[t.name])]))

// Cost: project from the measured per-viewing bytes/requests to a monthly scenario.
const rates = JSON.parse(await readFile(values.rates, 'utf8'))
const first = results[targets[0].name]
const bytesPerRound = first.bytes / ROUNDS
const reqPerRound = first.requests / ROUNDS
const SCENARIOS = [
  { label: 'light', viewsPerMonth: 1000 },
  { label: 'moderate', viewsPerMonth: 50_000 },
  { label: 'heavy', viewsPerMonth: 1_000_000 },
]
const cdnTarget = targets.find((t) => /cdn/i.test(t.name))
const measuredHit = cdnTarget ? results[cdnTarget.name].hitRatio : null
const hitRatio = measuredHit ?? 0.9
const cost = {
  assumptions: {
    hitRatio,
    hitRatioSource: measuredHit === null ? 'assumed (no CDN target measured)' : 'measured',
    bytesPerView: bytesPerRound,
    requestsPerView: reqPerRound,
    note: 'a "view" is one benchmark round: 2 manifests + the sampled segments, not a full viewing session',
  },
  scenarios: SCENARIOS.map((s) => {
    const p = { gbPerMonth: (bytesPerRound * s.viewsPerMonth) / 1e9, requestsPerMonth: reqPerRound * s.viewsPerMonth, hitRatio }
    return { ...s, ...p, ...monthlyCost(rates, p) }
  }),
  breakEvenGbPerMonth: breakEvenGb(rates, { gbPerMonth: 100, requestsPerMonth: (reqPerRound * 100e9) / bytesPerRound, hitRatio }),
  ratesNote: rates._note,
}

const report = {
  generatedAt: new Date().toISOString(),
  config: { slug: values.slug, rung: rung.file, segments: segs.length, rounds: ROUNDS, targets },
  results,
  perRound,
  cost,
}
await mkdir(dirname(values.out), { recursive: true })
await writeFile(values.out, JSON.stringify(report, null, 2) + '\n')

const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-')
console.log('\ntarget            reqs err  ttfb p50/p95/p99 (ms)     seg p50 (ms)  Mbps    hit%')
for (const t of targets) {
  const r = results[t.name]
  console.log(
    `${t.name.padEnd(16)} ${String(r.requests).padStart(5)} ${String(r.errors).padStart(3)}  ` +
      `${`${f(r.ttfbMs.p50)}/${f(r.ttfbMs.p95)}/${f(r.ttfbMs.p99)}`.padEnd(24)}  ${f(r.segmentMs.p50).padStart(11)}  ${f(r.segmentMbps, 0).padStart(5)}  ${r.hitRatio === null ? '   -' : f(r.hitRatio * 100, 0).padStart(4)}`,
  )
}
console.log(`\nreport written to ${values.out}`)
