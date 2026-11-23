// Turning the live telemetry into a saved run, and a saved run back into a comparison. Pure.
import { SLOT_COUNT } from '../state'
import { sessionEvents, summarize, type Summary } from '../telemetry/metrics'
import type { TelemetryEvent } from '../telemetry/types'
import type { EventsBlob, RunPayload } from './types'

export interface BuildInput {
  events: readonly TelemetryEvent[]
  /** performance.now() when saving: the events' `t` values are on this clock. */
  now: number
  /** performance.timeOrigin, to put that clock on the wall clock. */
  timeOrigin: number
  label?: string
  env?: Record<string, unknown>
  slots?: number
}

/**
 * The run as it stands: for every quadrant that has played, its latest session's events and summary.
 * Null when nothing has played, so there is nothing worth saving.
 */
export function buildRunPayload({ events, now, timeOrigin, label, env = {}, slots = SLOT_COUNT }: BuildInput): RunPayload | null {
  const sessions: RunPayload['sessions'] = []
  const kept: TelemetryEvent[] = []
  for (let slot = 0; slot < slots; slot++) {
    const own = sessionEvents(events, slot)
    const summary = summarize(events, slot, now)
    if (!own.length || !summary) continue
    sessions.push({ slot, streamId: own[0].streamId, delivery: own[0].delivery, summary })
    kept.push(...own)
  }
  if (!sessions.length) return null
  kept.sort((a, b) => a.t - b.t)
  const name = label?.trim()
  return {
    ...(name ? { label: name } : {}),
    startedAt: Math.round(timeOrigin + kept[0].t),
    endedAt: Math.round(timeOrigin + now),
    env,
    timeOrigin,
    nowMs: now,
    sessions,
    events: kept,
  }
}

export interface RebuiltRow {
  slot: number
  streamId: string
  delivery: string
  summary: Summary
}

/** The per-quadrant summaries recomputed from a saved blob, exactly as the live panel computed them. */
export function rebuildRows(blob: Pick<EventsBlob, 'events' | 'nowMs'>, slots = SLOT_COUNT): RebuiltRow[] {
  const rows: RebuiltRow[] = []
  for (let slot = 0; slot < slots; slot++) {
    const own = sessionEvents(blob.events, slot)
    const summary = summarize(blob.events, slot, blob.nowMs)
    if (own.length && summary) rows.push({ slot, streamId: own[0].streamId, delivery: own[0].delivery, summary })
  }
  return rows
}

/** "bbb-hls via Origin, S3 near" style text for a run list: one entry per distinct stream, with its deliveries. */
export function describeRun(sessions: readonly { streamId: string; delivery: string }[], labelOf: (delivery: string) => string): string {
  const byStream = new Map<string, string[]>()
  for (const s of sessions) byStream.set(s.streamId, [...(byStream.get(s.streamId) ?? []), labelOf(s.delivery)])
  return [...byStream].map(([stream, ds]) => `${stream} via ${ds.join(', ')}`).join('; ')
}
