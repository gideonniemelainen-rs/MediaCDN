// Which quadrant is doing best on each metric. Only quadrants playing the same stream are
// compared (a different title or ladder would make the numbers meaningless), so the comparison
// only lights up when the same title is loaded from several deliveries. Pure.
import type { Summary } from './metrics'

export type CompareKey =
  | 'startupMs'
  | 'rebufferCount'
  | 'rebufferRatio'
  | 'meanSegmentLatencyMs'
  | 'throughputKbps'
  | 'avgBitrateKbps'
  | 'errors'

/** Which direction is better for each compared metric. Switch counts are left out: neither is better. */
export const BETTER: Record<CompareKey, 'low' | 'high'> = {
  startupMs: 'low',
  rebufferCount: 'low',
  rebufferRatio: 'low',
  meanSegmentLatencyMs: 'low',
  throughputKbps: 'high',
  avgBitrateKbps: 'high',
  errors: 'low',
}

export interface CompareRow {
  slot: number
  streamId: string | undefined
  summary: Summary
  /** The ABR height cap: a height, null when uncapped, undefined when not recorded (treated as unknown). */
  maxHeight?: number | null
}

export type Best = Record<CompareKey, Set<number>>

/** Metrics that follow from the rung the player picked, so a cap on one quadrant but not another makes them incomparable. */
const CAP_DEPENDENT: readonly CompareKey[] = ['avgBitrateKbps']

/** Quadrants of one stream whose ABR cap differs from another's: the ones that were actually limited. Empty when the known caps agree. */
export function cappedSlots(group: readonly CompareRow[]): number[] {
  const known = group.filter((r) => r.maxHeight !== undefined)
  return new Set(known.map((r) => r.maxHeight)).size > 1 ? known.filter((r) => r.maxHeight !== null).map((r) => r.slot) : []
}

/** Slots that were capped while another quadrant playing the same stream was not (or was capped differently). */
export function capMismatches(rows: readonly CompareRow[]): number[] {
  const groups = new Map<string, CompareRow[]>()
  for (const r of rows) if (r.streamId) groups.set(r.streamId, [...(groups.get(r.streamId) ?? []), r])
  return [...groups.values()].flatMap(cappedSlots).sort((a, b) => a - b)
}

export function bestSlots(rows: readonly CompareRow[]): Best {
  const best = Object.fromEntries((Object.keys(BETTER) as CompareKey[]).map((k) => [k, new Set<number>()])) as Best
  const groups = new Map<string, CompareRow[]>()
  for (const r of rows) {
    if (r.streamId) groups.set(r.streamId, [...(groups.get(r.streamId) ?? []), r])
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const capsDiffer = cappedSlots(group).length > 0
    for (const key of Object.keys(BETTER) as CompareKey[]) {
      if (capsDiffer && CAP_DEPENDENT.includes(key)) continue
      const values = group.flatMap((r) => (r.summary[key] === null ? [] : [{ slot: r.slot, v: r.summary[key] as number }]))
      if (values.length < 2) continue
      const target = BETTER[key] === 'low' ? Math.min(...values.map((x) => x.v)) : Math.max(...values.map((x) => x.v))
      // All equal is no difference worth pointing at.
      if (values.every((x) => x.v === target)) continue
      for (const x of values) if (x.v === target) best[key].add(x.slot)
    }
  }
  return best
}
