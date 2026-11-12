import type { TelemetryEvent } from './types'

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
  }
}

export function toJSON(events: readonly TelemetryEvent[]): string {
  return JSON.stringify(events, null, 2)
}

const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`

export function toCSV(events: readonly TelemetryEvent[]): string {
  const rows = events.map((e) =>
    [e.t.toFixed(1), e.slot, e.streamId, e.delivery, e.type, esc(JSON.stringify(e.data))].join(','),
  )
  return ['t_ms,slot,stream,delivery,type,data', ...rows].join('\n')
}
