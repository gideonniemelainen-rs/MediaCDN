// The arithmetic behind the line charts: ticks, lookups at a time, and the table twin. Pure.
import type { Point } from './series'

/** Round tick values covering [min, max], about `count` of them, on 1/2/5 × 10ⁿ steps. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min]
  const raw = (max - min) / Math.max(1, count)
  const pow = 10 ** Math.floor(Math.log10(raw))
  const f = raw / pow
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow
  const ticks: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step)
  return ticks
}

/** The top of the y axis: the data's maximum rounded up to the next tick, never below `floor`. */
export function niceMax(max: number, floor = 1): number {
  const m = Math.max(max, floor)
  const ticks = niceTicks(0, m, 4)
  const top = ticks[ticks.length - 1]
  return top >= m ? top : top + (ticks[1] - ticks[0])
}

/** 0, 500, 1K, 2.5K, 12K: compact from 1,000 up. */
export function formatCompact(v: number): string {
  const a = Math.abs(v)
  if (a < 1000) return String(Math.round(v * 10) / 10)
  const k = v / 1000
  return `${Number.isInteger(k) ? k : k.toFixed(1).replace(/\.0$/, '')}K`
}

/** A time in seconds for an axis: 0, 15, 90 → "0s", "15s", "1:30". */
export function formatSeconds(s: number): string {
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.round(s - m * 60)).padStart(2, '0')}`
}

/** The point's value at time `t`. 'step': the latest point at or before `t` (a setting that holds until changed).
 *  'nearest': the closest point, but only within `maxGap` seconds (a measurement is not made up between samples). */
export function valueAt(points: readonly Point[], t: number, mode: 'step' | 'nearest', maxGap = 1.5): number | null {
  if (!points.length) return null
  let lo = 0
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (points[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  if (mode === 'step') return points[lo].t <= t ? points[lo].v : null
  const candidates = [points[lo], points[lo + 1]].filter((p): p is Point => !!p)
  const best = candidates.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
  return Math.abs(best.t - t) <= maxGap ? best.v : null
}

/** The data position nearest to `t` among every series' times (what the crosshair snaps to). */
export function snapTime(series: readonly (readonly Point[])[], t: number): number | null {
  let best: number | null = null
  for (const points of series) {
    if (!points.length) continue
    let lo = 0
    let hi = points.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (points[mid].t <= t) lo = mid
      else hi = mid - 1
    }
    for (const p of [points[lo], points[lo + 1]]) {
      if (p && (best === null || Math.abs(p.t - t) < Math.abs(best - t))) best = p.t
    }
  }
  return best
}

export interface TableSeries {
  label: string
  points: readonly Point[]
  mode: 'step' | 'nearest'
}

/** The chart's table twin: one row per `step` seconds, one column per series, null where there is no value. */
export function tableRows(series: readonly TableSeries[], duration: number, step = 1, maxRows = 120): { t: number; values: (number | null)[] }[] {
  const every = Math.max(step, duration / maxRows)
  const rows: { t: number; values: (number | null)[] }[] = []
  for (let t = 0; t <= duration + 1e-9; t += every) {
    const at = Math.round(t * 100) / 100
    rows.push({ t: at, values: series.map((s) => valueAt(s.points, at, s.mode, Math.max(1.5, every))) })
  }
  return rows
}

/** Where a series stays flat after its last point so a step line reaches the end of the run. */
export function extendTo(points: readonly Point[], t: number): Point[] {
  if (!points.length || points[points.length - 1].t >= t) return [...points]
  return [...points, { t, v: points[points.length - 1].v }]
}
