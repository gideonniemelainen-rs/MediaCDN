// Time series rebuilt from a saved run's telemetry events, one set per quadrant. Pure.
// Times are seconds since that quadrant's own load-start, so quadrants that began a moment apart still line up.
import { SLOT_COUNT } from '../state'
import { sessionEvents } from '../telemetry/metrics'
import type { TelemetryEvent } from '../telemetry/types'
import type { EventsBlob } from './types'

export interface Point {
  /** Seconds since this quadrant's load-start. */
  t: number
  v: number
}

export interface QuadrantSeries {
  slot: number
  streamId: string
  delivery: string
  /** Seconds from load-start to the moment the run was saved. */
  duration: number
  /** Selected variant's bandwidth in kbps; holds its value until the next change. */
  bitrate: Point[]
  /** Seconds of media buffered ahead of the playhead, sampled about once a second. */
  buffer: Point[]
  /** Time each segment took to arrive, in ms, at the moment it arrived. */
  latency: Point[]
  /** When playback stalled after it had started (buffering before the first frame is startup, not a rebuffer). */
  rebuffers: number[]
  firstFrame: number | null
  /** The height the quadrant's ABR was capped to (an unfocused quadrant), or null when it was not capped. */
  maxHeight: number | null
  /** False when the run has no cap record for this quadrant (saved before caps were kept), so null means unknown. */
  capKnown: boolean
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function buildSeries(blob: Pick<EventsBlob, 'events' | 'nowMs'>, slots = SLOT_COUNT): QuadrantSeries[] {
  const out: QuadrantSeries[] = []
  for (let slot = 0; slot < slots; slot++) {
    const ev = sessionEvents(blob.events, slot)
    if (!ev.length) continue
    const t0 = ev[0].t
    const at = (e: TelemetryEvent) => Math.max(0, (e.t - t0) / 1000)
    const firstFrameEvent = ev.find((e) => e.type === 'first-frame')

    const bitrate: Point[] = []
    const buffer: Point[] = []
    const latency: Point[] = []
    const rebuffers: number[] = []
    // The cap is set when the quadrant mounts, which is before load-start, so look at the quadrant's whole log.
    const caps = blob.events.filter((e) => e.slot === slot && e.type === 'abr-cap')
    const lastCap = caps[caps.length - 1]
    // Infinity does not survive JSON: an uncapped quadrant was saved as null.
    const maxHeight = lastCap ? num(lastCap.data.maxHeight) : null
    for (const e of ev) {
      if (e.type === 'variant-change') {
        const bw = num(e.data.bandwidth)
        if (bw !== null) bitrate.push({ t: at(e), v: bw / 1000 })
      } else if (e.type === 'sample') {
        const ahead = num(e.data.bufferedAhead)
        if (ahead !== null) buffer.push({ t: at(e), v: ahead })
      } else if (e.type === 'request' && e.data.kind === 'segment') {
        const ms = num(e.data.latencyMs)
        if (ms !== null) latency.push({ t: at(e), v: ms })
      } else if (e.type === 'buffering-start' && firstFrameEvent && e.t >= firstFrameEvent.t) {
        rebuffers.push(at(e))
      }
    }
    out.push({
      slot,
      streamId: ev[0].streamId,
      delivery: ev[0].delivery,
      duration: Math.max(0, (blob.nowMs - t0) / 1000),
      bitrate,
      buffer,
      latency,
      rebuffers,
      firstFrame: firstFrameEvent ? at(firstFrameEvent) : null,
      maxHeight,
      capKnown: caps.length > 0,
    })
  }
  return out
}

/** Quadrants whose bitrate was limited by an ABR cap that others did not have. Empty when they all match. */
export function capMismatch(series: readonly QuadrantSeries[]): QuadrantSeries[] {
  const known = series.filter((s) => s.capKnown)
  const caps = new Set(known.map((s) => s.maxHeight))
  return caps.size > 1 ? known.filter((s) => s.maxHeight !== null) : []
}
