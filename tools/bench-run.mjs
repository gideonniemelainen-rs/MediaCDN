// The delivery benchmark as a function: fetches the same packaged title through several base URLs ("targets") and
// compares latency, throughput and cache behaviour. Rounds rotate the starting target so drift in network conditions hits
// all of them equally. It returns the report and writes nothing: tools/bench.mjs (the CLI) and the Workflows run each
// decide where the report goes.
//
// A target is any host serving the layout of origin/ (master.m3u8, media_N.m3u8, chunk-*.m4s).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HLS_MASTER, mediaPlaylistRep, parseMediaPlaylist } from '../shared/src/title-layout.ts'
import { breakEvenGb, cacheStatus, monthlyCost, summarizeTarget } from './bench-lib.mjs'

const ORIGIN_DIR = fileURLToPath(new URL('../origin/', import.meta.url))

const SCENARIOS = [
  { label: 'light', viewsPerMonth: 1000 },
  { label: 'moderate', viewsPerMonth: 50_000 },
  { label: 'heavy', viewsPerMonth: 1_000_000 },
]

/** One GET: time to headers, time to last byte, bytes, cache status. */
async function timed(fetchFn, url, kind) {
  const t0 = performance.now()
  try {
    const res = await fetchFn(url, { cache: 'no-store' })
    const ttfbMs = performance.now() - t0
    const bytes = (await res.arrayBuffer()).byteLength
    const totalMs = performance.now() - t0
    return { kind, ttfbMs, totalMs, bytes, status: res.status, cache: cacheStatus(Object.fromEntries(res.headers)) }
  } catch (e) {
    return { kind, ttfbMs: 0, totalMs: performance.now() - t0, bytes: 0, status: 0, cache: 'unknown', error: String(e.cause?.code ?? e.message) }
  }
}

/** `name=baseUrl` strings to targets. */
export function parseTargets(specs) {
  return specs.map((t) => {
    const i = t.indexOf('=')
    if (i < 1) throw new Error(`bad target "${t}", expected name=baseUrl`)
    return { name: t.slice(0, i), base: t.slice(i + 1).replace(/\/$/, '') }
  })
}

/**
 * @param {object} o
 * @param {{name: string, base: string}[]} o.targets
 * @param {string} o.slug       the packaged title in `originDir` that every target serves
 * @param {number} o.rounds
 * @param {number} o.segments   segments fetched per round
 * @param {object} o.rates      the price table (bench/rates.json)
 * @param {string} [o.originDir]
 * @param {typeof fetch} [o.fetchFn]
 * @param {{log?: (line: string) => void, progress?: (p: number) => void, signal?: AbortSignal}} [h]
 */
export async function runBench({ targets, slug, rounds, segments, rates, originDir = ORIGIN_DIR, fetchFn = fetch }, { log = () => {}, progress = () => {}, signal } = {}) {
  if (!targets.length) throw new Error('need at least one target')
  // Segment list: taken from the local packaged playlist so every target fetches identical objects regardless of which is tested.
  const master = await readFile(join(originDir, slug, HLS_MASTER), 'utf8')
  const media = master.split(/\r?\n/).filter((l) => mediaPlaylistRep(l) !== null)
  const rungs = await Promise.all(media.map(async (f) => ({ file: f, ...parseMediaPlaylist(await readFile(join(originDir, slug, f), 'utf8')) })))
  if (!rungs.length) throw new Error(`${slug} has no media playlists in its master`)
  const rung = rungs[Math.floor(rungs.length / 2)] // a middle rung: representative, not the smallest
  const segs = rung.segments.slice(0, segments).map((s) => s.uri)
  log(`slug=${slug} rung=${rung.file} segments=${segs.length} rounds=${rounds} targets=${targets.map((t) => t.name).join(',')}`)

  const samples = Object.fromEntries(targets.map((t) => [t.name, []]))
  const perRound = Object.fromEntries(targets.map((t) => [t.name, []]))
  for (let round = 0; round < rounds; round++) {
    signal?.throwIfAborted()
    // Rotate the starting target each round so none is always first (or always cold).
    const order = targets.map((_, i) => targets[(i + round) % targets.length])
    for (const t of order) {
      const batch = []
      batch.push(await timed(fetchFn, `${t.base}/${slug}/${HLS_MASTER}`, 'manifest'))
      batch.push(await timed(fetchFn, `${t.base}/${slug}/${rung.file}`, 'manifest'))
      for (const s of segs) batch.push(await timed(fetchFn, `${t.base}/${slug}/${s}`, 'segment'))
      samples[t.name].push(...batch)
      perRound[t.name].push({ round, firstSegmentMs: batch[2]?.totalMs ?? null, ttfbMs: batch[2]?.ttfbMs ?? null, cache: batch[2]?.cache ?? 'unknown' })
    }
    progress((round + 1) / rounds)
    log(`round ${round + 1} of ${rounds}`)
  }

  const results = Object.fromEntries(targets.map((t) => [t.name, summarizeTarget(samples[t.name])]))

  // Cost: project from the measured per-viewing bytes/requests to a monthly scenario.
  const first = results[targets[0].name]
  const bytesPerRound = first.bytes / rounds
  const reqPerRound = first.requests / rounds
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

  return {
    generatedAt: new Date().toISOString(),
    config: { slug, rung: rung.file, segments: segs.length, rounds, targets },
    results,
    perRound,
    cost,
  }
}

/** The comparison table of a report, one line per entry. */
export function summaryLines(report) {
  const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-')
  const lines = ['target            reqs err  ttfb p50/p95/p99 (ms)     seg p50 (ms)  Mbps    hit%']
  for (const t of report.config.targets) {
    const r = report.results[t.name]
    lines.push(
      `${t.name.padEnd(16)} ${String(r.requests).padStart(5)} ${String(r.errors).padStart(3)}  ` +
        `${`${f(r.ttfbMs.p50)}/${f(r.ttfbMs.p95)}/${f(r.ttfbMs.p99)}`.padEnd(24)}  ${f(r.segmentMs.p50).padStart(11)}  ${f(r.segmentMbps, 0).padStart(5)}  ${r.hitRatio === null ? '   -' : f(r.hitRatio * 100, 0).padStart(4)}`,
    )
  }
  return lines
}
