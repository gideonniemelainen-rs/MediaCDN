import { describe, expect, it } from 'vitest'
import { extendTo, formatCompact, formatSeconds, niceMax, niceTicks, snapTime, tableRows, valueAt } from './chart-math'

describe('niceTicks', () => {
  it('uses round steps that cover the range', () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10])
    expect(niceTicks(0, 2800, 4)).toEqual([0, 1000, 2000])
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.5, 1])
  })
  it('handles an empty range', () => {
    expect(niceTicks(5, 5)).toEqual([5])
  })
})

describe('niceMax', () => {
  it('rounds the data maximum up to a tick', () => {
    expect(niceMax(2800)).toBe(3000)
    expect(niceMax(9)).toBeGreaterThanOrEqual(9)
    expect(niceMax(0, 10)).toBe(10)
  })
})

describe('formatting', () => {
  it('is compact from 1,000 up', () => {
    expect([0, 250, 999, 1000, 2500, 12000].map(formatCompact)).toEqual(['0', '250', '999', '1K', '2.5K', '12K'])
  })
  it('shows seconds, then minutes', () => {
    expect([0, 15, 59.5, 90, 605].map(formatSeconds)).toEqual(['0s', '15s', '59.5s', '1:30', '10:05'])
  })
})

const P = [{ t: 0, v: 10 }, { t: 2, v: 20 }, { t: 5, v: 30 }]

describe('valueAt', () => {
  it('holds a step value until the next change, and has none before the first', () => {
    expect(valueAt(P, 0, 'step')).toBe(10)
    expect(valueAt(P, 1.9, 'step')).toBe(10)
    expect(valueAt(P, 2, 'step')).toBe(20)
    expect(valueAt(P, 99, 'step')).toBe(30)
    expect(valueAt([{ t: 3, v: 1 }], 1, 'step')).toBeNull()
  })
  it('takes the nearest measurement within the gap, and does not invent one beyond it', () => {
    expect(valueAt(P, 2.4, 'nearest')).toBe(20)
    expect(valueAt(P, 4, 'nearest')).toBe(30)
    expect(valueAt(P, 3.5, 'nearest', 1)).toBeNull()
    expect(valueAt([], 1, 'nearest')).toBeNull()
  })
})

describe('snapTime', () => {
  it('snaps to the nearest data position across series', () => {
    expect(snapTime([P, [{ t: 3.1, v: 1 }]], 3)).toBe(3.1)
    expect(snapTime([P], 0.4)).toBe(0)
    expect(snapTime([[], []], 1)).toBeNull()
  })
})

describe('tableRows', () => {
  it('gives one row per step with a value per series', () => {
    const rows = tableRows([{ label: 'a', points: P, mode: 'step' }, { label: 'b', points: [{ t: 4, v: 7 }], mode: 'nearest' }], 5, 1)
    expect(rows.map((r) => r.t)).toEqual([0, 1, 2, 3, 4, 5])
    expect(rows[2].values).toEqual([20, null])
    expect(rows[4].values).toEqual([20, 7])
  })
  it('thins a long run to the row limit', () => {
    expect(tableRows([{ label: 'a', points: P, mode: 'step' }], 1000, 1, 100).length).toBeLessThanOrEqual(101)
  })
})

describe('extendTo', () => {
  it('holds the last value out to the end of the run', () => {
    expect(extendTo(P, 8).at(-1)).toEqual({ t: 8, v: 30 })
    expect(extendTo(P, 5)).toEqual(P)
    expect(extendTo([], 5)).toEqual([])
  })
})
