import { describe, expect, it } from 'vitest'
import type { TelemetryEvent } from '../telemetry/types'
import { buildSeries, capMismatch } from './series'

const ev = (slot: number, type: TelemetryEvent['type'], t: number, data: Record<string, unknown> = {}, over: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
  t, slot, streamId: 'bbb-hls', delivery: slot === 0 ? 'local' : 's3-near', type, data, ...over,
})

const EVENTS: TelemetryEvent[] = [
  // Slot 0: loads at t=1000 ms, first frame 40 ms later, one rebuffer, one ABR change.
  ev(0, 'load-start', 1000), ev(0, 'abr-cap', 1000, { maxHeight: null }),
  ev(0, 'buffering-start', 1010), ev(0, 'buffering-end', 1030), // startup buffering: not a rebuffer
  ev(0, 'variant-change', 1020, { bandwidth: 800_000 }), ev(0, 'first-frame', 1040),
  ev(0, 'request', 1050, { kind: 'segment', latencyMs: 8 }), ev(0, 'request', 1060, { kind: 'manifest', latencyMs: 99 }),
  ev(0, 'sample', 2000, { bufferedAhead: 6.5 }), ev(0, 'sample', 3000, { bufferedAhead: 9 }),
  ev(0, 'variant-change', 3500, { bandwidth: 2_800_000 }),
  ev(0, 'buffering-start', 4000), ev(0, 'buffering-end', 4500),
  // Slot 1: loads later, capped, nothing else.
  ev(1, 'load-start', 1500), ev(1, 'abr-cap', 1500, { maxHeight: 360 }), ev(1, 'variant-change', 1600, { bandwidth: 932_000 }),
]

describe('buildSeries', () => {
  const s = buildSeries({ events: EVENTS, nowMs: 6000 })

  it('has one entry per quadrant that played, with identity', () => {
    expect(s.map((x) => [x.slot, x.streamId, x.delivery])).toEqual([[0, 'bbb-hls', 'local'], [1, 'bbb-hls', 's3-near']])
  })

  it('measures time from each quadrant\'s own load-start', () => {
    expect(s[0].bitrate).toEqual([{ t: 0.02, v: 800 }, { t: 2.5, v: 2800 }])
    expect(s[1].bitrate).toEqual([{ t: 0.1, v: 932 }])
    expect(s[0].duration).toBe(5)
    expect(s[1].duration).toBe(4.5)
  })

  it('takes buffer from samples and latency from segment requests only', () => {
    expect(s[0].buffer).toEqual([{ t: 1, v: 6.5 }, { t: 2, v: 9 }])
    expect(s[0].latency).toEqual([{ t: 0.05, v: 8 }])
  })

  it('counts a stall only after the first frame', () => {
    expect(s[0].firstFrame).toBeCloseTo(0.04)
    expect(s[0].rebuffers).toEqual([3])
  })

  it('reads the ABR cap, where an uncapped quadrant was saved as null', () => {
    expect(s[0].maxHeight).toBeNull()
    expect(s[1].maxHeight).toBe(360)
  })

  it('reads a cap that was set before load-start, as it is when a quadrant mounts', () => {
    const early = [ev(1, 'abr-cap', 500, { maxHeight: 360 }), ev(1, 'load-start', 1500), ev(1, 'variant-change', 1600, { bandwidth: 932_000 })]
    const r = buildSeries({ events: early, nowMs: 3000 })[0]
    expect(r.maxHeight).toBe(360)
    expect(r.capKnown).toBe(true)
  })

  it('uses the last cap in force, so a quadrant that gained focus is no longer capped', () => {
    const changed = [ev(0, 'abr-cap', 100, { maxHeight: 360 }), ev(0, 'load-start', 200), ev(0, 'abr-cap', 900, { maxHeight: null })]
    expect(buildSeries({ events: changed, nowMs: 2000 })[0].maxHeight).toBeNull()
  })

  it('says the cap is unknown when the run has no cap record, instead of calling the quadrant uncapped', () => {
    const r = buildSeries({ events: [ev(0, 'load-start', 0)], nowMs: 1000 })[0]
    expect(r.capKnown).toBe(false)
    expect(r.maxHeight).toBeNull()
  })

  it('has nothing for quadrants that never loaded, and ignores an earlier session of a quadrant', () => {
    expect(buildSeries({ events: [], nowMs: 1 })).toEqual([])
    const replayed = [ev(0, 'load-start', 1), ev(0, 'sample', 2, { bufferedAhead: 99 }), ...EVENTS]
    expect(buildSeries({ events: replayed, nowMs: 6000 })[0].buffer.every((p) => p.v !== 99)).toBe(true)
  })

  it('skips non-numeric values rather than plotting them', () => {
    const odd = [ev(0, 'load-start', 0), ev(0, 'sample', 10, { bufferedAhead: 'x' }), ev(0, 'request', 20, { kind: 'segment', latencyMs: null }), ev(0, 'variant-change', 30, {})]
    const r = buildSeries({ events: odd, nowMs: 100 })[0]
    expect([r.buffer, r.latency, r.bitrate]).toEqual([[], [], []])
  })
})

describe('capMismatch', () => {
  it('flags the capped quadrants when caps differ, and nothing when they match', () => {
    const s = buildSeries({ events: EVENTS, nowMs: 6000 })
    expect(capMismatch(s).map((x) => x.slot)).toEqual([1])
    expect(capMismatch([s[0], s[0]])).toEqual([])
    expect(capMismatch([s[1], { ...s[1], slot: 2 }])).toEqual([])
  })

  it('ignores quadrants whose cap is unknown rather than treating them as uncapped', () => {
    const s = buildSeries({ events: EVENTS, nowMs: 6000 })
    expect(capMismatch([{ ...s[0], capKnown: false }, s[1]])).toEqual([])
  })
})
