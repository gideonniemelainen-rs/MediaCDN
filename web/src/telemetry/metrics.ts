import type { TelemetryEvent } from './types'
import { normaliseTransport, type ObservedTransport } from './transport'

export interface Summary {
  startupMs: number | null
  rebufferCount: number
  rebufferMs: number
  /** Share of time since the first frame spent rebuffering, 0..1. */
  rebufferRatio: number
  switches: number
  avgBitrateKbps: number | null
  errors: number
  requests: number
  meanSegmentLatencyMs: number | null
  throughputKbps: number | null
  liveLatencyS: number | null
  /** The protocol most of the session's requests were observed to use; null before any request. */
  transport: ObservedTransport | null
  /** Mean request-to-first-byte time over requests that reported one. Null when the browser hid it. */
  meanTtfbMs: number | null
  /** Mean connection setup time over the requests that opened a connection (a reused one costs 0). Null when none did. */
  meanConnectMs: number | null
}

/** The protocol seen most often among requests that reported one, `unknown` if none did, null with no requests. */
export function dominantTransport(requests: readonly TelemetryEvent[]): ObservedTransport | null {
  if (requests.length === 0) return null
  const counts = new Map<ObservedTransport, number>()
  for (const r of requests) {
    const t = normaliseTransport(typeof r.data.transport === 'string' ? r.data.transport : undefined)
    if (t !== 'unknown') counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  let best: ObservedTransport | null = null
  for (const [t, n] of counts) if (best === null || n > counts.get(best)!) best = t
  return best ?? 'unknown'
}

/** Events of the slot's most recent load, from its `load-start` onward. */
export function sessionEvents(events: readonly TelemetryEvent[], slot: number): TelemetryEvent[] {
  const mine = events.filter((e) => e.slot === slot)
  let start = -1
  for (let i = mine.length - 1; i >= 0; i--) {
    if (mine[i].type === 'load-start') {
      start = i
      break
    }
  }
  return start < 0 ? [] : mine.slice(start)
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function summarize(events: readonly TelemetryEvent[], slot: number, now: number): Summary | null {
  const ev = sessionEvents(events, slot)
  if (ev.length === 0) return null

  const start = ev[0].t
  const firstFrame = ev.find((e) => e.type === 'first-frame')
  const startupMs = firstFrame ? firstFrame.t - start : null

  // Buffering before the first frame is startup, not a rebuffer.
  let rebufferCount = 0
  let rebufferMs = 0
  let openSince: number | null = null
  for (const e of ev) {
    if (!firstFrame || e.t < firstFrame.t) continue
    if (e.type === 'buffering-start' && openSince === null) {
      openSince = e.t
      rebufferCount++
    } else if (e.type === 'buffering-end' && openSince !== null) {
      rebufferMs += e.t - openSince
      openSince = null
    }
  }
  if (openSince !== null) rebufferMs += now - openSince
  const watchMs = firstFrame ? now - firstFrame.t : 0
  const rebufferRatio = watchMs > 0 ? Math.min(1, rebufferMs / watchMs) : 0

  const variants = ev.filter((e) => e.type === 'variant-change')
  let weighted = 0
  let span = 0
  variants.forEach((v, i) => {
    const bw = num(v.data.bandwidth)
    if (bw === null) return
    const end = i + 1 < variants.length ? variants[i + 1].t : now
    weighted += bw * (end - v.t)
    span += end - v.t
  })

  const segments = ev.filter((e) => e.type === 'request' && e.data.kind === 'segment')
  let latency = 0
  let bytes = 0
  for (const r of segments) {
    latency += num(r.data.latencyMs) ?? 0
    bytes += num(r.data.bytes) ?? 0
  }

  const requests = ev.filter((e) => e.type === 'request')
  const ttfb = requests.flatMap((r) => num(r.data.ttfbMs) ?? [])
  const connects = requests.flatMap((r) => num(r.data.connectMs) ?? []).filter((c) => c > 0)
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

  const lastSample = [...ev].reverse().find((e) => e.type === 'sample')

  return {
    startupMs,
    rebufferCount,
    rebufferMs,
    rebufferRatio,
    switches: Math.max(0, variants.length - 1),
    avgBitrateKbps: span > 0 ? weighted / span / 1000 : null,
    errors: ev.filter((e) => e.type === 'error').length,
    requests: ev.filter((e) => e.type === 'request').length,
    meanSegmentLatencyMs: segments.length ? latency / segments.length : null,
    throughputKbps: latency > 0 ? (bytes * 8) / latency : null,
    liveLatencyS: lastSample ? num(lastSample.data.liveLatencyS) : null,
    transport: dominantTransport(requests),
    meanTtfbMs: mean(ttfb),
    meanConnectMs: mean(connects),
  }
}

export interface TransportGroup {
  delivery: string
  transport: ObservedTransport
  /** How many quadrants fall in the group. */
  quadrants: number
  startupMs: number | null
  rebufferRatio: number | null
  meanSegmentLatencyMs: number | null
  throughputKbps: number | null
  meanTtfbMs: number | null
  meanConnectMs: number | null
}

/**
 * Quadrants grouped by delivery and the protocol actually observed, with each metric averaged over
 * the group's quadrants that have it. The grouping uses what was observed rather than what was asked
 * for, so a fallback (h3 requested, h2 served) shows up under h2.
 */
export function summarizeByTransport(rows: readonly { delivery?: string; summary: Summary | null }[]): TransportGroup[] {
  const groups = new Map<string, { delivery: string; transport: ObservedTransport; summaries: Summary[] }>()
  for (const { delivery, summary } of rows) {
    if (!summary?.transport) continue
    const key = `${delivery ?? '?'}|${summary.transport}`
    const g = groups.get(key) ?? { delivery: delivery ?? '?', transport: summary.transport, summaries: [] }
    g.summaries.push(summary)
    groups.set(key, g)
  }
  const mean = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null)
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
  }
  return [...groups.values()]
    .map(({ delivery, transport, summaries: s }) => ({
      delivery,
      transport,
      quadrants: s.length,
      startupMs: mean(s.map((x) => x.startupMs)),
      rebufferRatio: mean(s.map((x) => x.rebufferRatio)),
      meanSegmentLatencyMs: mean(s.map((x) => x.meanSegmentLatencyMs)),
      throughputKbps: mean(s.map((x) => x.throughputKbps)),
      meanTtfbMs: mean(s.map((x) => x.meanTtfbMs)),
      meanConnectMs: mean(s.map((x) => x.meanConnectMs)),
    }))
    .sort((a, b) => a.delivery.localeCompare(b.delivery) || a.transport.localeCompare(b.transport))
}

export function toJSON(events: readonly TelemetryEvent[]): string {
  return JSON.stringify(events, null, 2)
}

const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`

export function toCSV(events: readonly TelemetryEvent[]): string {
  // The observed protocol is only known for requests; other events leave the column empty.
  const transport = (e: TelemetryEvent) => (e.type === 'request' && typeof e.data.transport === 'string' ? e.data.transport : '')
  const rows = events.map((e) =>
    [e.t.toFixed(1), e.slot, e.streamId, e.delivery, transport(e), e.type, esc(JSON.stringify(e.data))].join(','),
  )
  return ['t_ms,slot,stream,delivery,transport,type,data', ...rows].join('\n')
}
