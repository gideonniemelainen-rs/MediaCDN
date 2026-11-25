import { describe, expect, it } from 'vitest'
import { bestSlots, type CompareRow } from './compare'
import type { Summary } from './metrics'

const summary = (over: Partial<Summary>): Summary => ({
  startupMs: 500, rebufferCount: 0, rebufferMs: 0, rebufferRatio: 0, switches: 0, avgBitrateKbps: 2000,
  errors: 0, requests: 10, meanSegmentLatencyMs: 80, throughputKbps: 8000, liveLatencyS: null,
  transport: null, meanTtfbMs: null, meanConnectMs: null, ...over,
})
const row = (slot: number, streamId: string | undefined, over: Partial<Summary> = {}): CompareRow => ({ slot, streamId, summary: summary(over) })
const slots = (s: Set<number>) => [...s].sort()

describe('bestSlots', () => {
  it('marks the lowest startup and latency and the highest throughput among the same stream', () => {
    const best = bestSlots([
      row(0, 'bbb-hls', { startupMs: 300, meanSegmentLatencyMs: 40, throughputKbps: 20000 }),
      row(1, 'bbb-hls', { startupMs: 900, meanSegmentLatencyMs: 260, throughputKbps: 5000 }),
      row(2, 'bbb-hls', { startupMs: 600, meanSegmentLatencyMs: 90, throughputKbps: 9000 }),
    ])
    expect(slots(best.startupMs)).toEqual([0])
    expect(slots(best.meanSegmentLatencyMs)).toEqual([0])
    expect(slots(best.throughputKbps)).toEqual([0])
  })

  it('marks every slot that ties for best', () => {
    const best = bestSlots([row(0, 'a', { startupMs: 100 }), row(1, 'a', { startupMs: 100 }), row(2, 'a', { startupMs: 400 })])
    expect(slots(best.startupMs)).toEqual([0, 1])
  })

  it('points at nothing when everyone is equal', () => {
    const best = bestSlots([row(0, 'a'), row(1, 'a')])
    for (const set of Object.values(best)) expect(set.size).toBe(0)
  })

  it('never compares different streams', () => {
    const best = bestSlots([row(0, 'bbb-hls', { startupMs: 100 }), row(1, 'agent-327-hls', { startupMs: 900 })])
    for (const set of Object.values(best)) expect(set.size).toBe(0)
  })

  it('compares within each group when two titles are each loaded twice', () => {
    const best = bestSlots([
      row(0, 'a', { startupMs: 100 }), row(1, 'b', { startupMs: 50 }),
      row(2, 'a', { startupMs: 300 }), row(3, 'b', { startupMs: 90 }),
    ])
    expect(slots(best.startupMs)).toEqual([0, 1])
  })

  it('treats fewer rebuffers and errors as better, and ignores slots with no value', () => {
    const best = bestSlots([
      row(0, 'a', { rebufferCount: 3, rebufferRatio: 0.1, errors: 1 }),
      row(1, 'a', { rebufferCount: 0, rebufferRatio: 0, errors: 0 }),
      row(2, 'a', { startupMs: null }),
    ])
    expect(slots(best.rebufferCount)).toEqual([1, 2])
    expect(slots(best.errors)).toEqual([1, 2])
    expect(best.startupMs.size).toBe(0) // 500 vs 500 among the two that have a value
  })

  it('needs at least two values to compare', () => {
    const best = bestSlots([row(0, 'a', { startupMs: 100 }), row(1, 'a', { startupMs: null })])
    expect(best.startupMs.size).toBe(0)
  })

  it('ignores quadrants with no stream', () => {
    const best = bestSlots([row(0, undefined, { startupMs: 1 }), row(1, undefined, { startupMs: 9 })])
    for (const set of Object.values(best)) expect(set.size).toBe(0)
  })
})
