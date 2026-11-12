import { describe, expect, it } from 'vitest'
import { Telemetry } from './store'
import { summarize, toCSV } from './metrics'
import type { EventType, TelemetryEvent } from './types'

const ev = (t: number, type: EventType, data: Record<string, unknown> = {}, slot = 0): TelemetryEvent => ({
  t,
  slot,
  streamId: 'bbb',
  delivery: 'direct',
  type,
  data,
})

describe('summarize', () => {
  it('returns null before any load', () => {
    expect(summarize([], 0, 1000)).toBeNull()
  })

  it('computes startup, rebuffering and bitrate switches', () => {
    const events = [
      ev(1000, 'load-start'),
      ev(1100, 'buffering-start'), // startup buffering: not a rebuffer
      ev(1400, 'buffering-end'),
      ev(1500, 'variant-change', { bandwidth: 1_000_000 }),
      ev(1600, 'first-frame'),
      ev(3000, 'buffering-start'),
      ev(3500, 'buffering-end'),
      ev(4000, 'variant-change', { bandwidth: 3_000_000 }),
    ]
    const s = summarize(events, 0, 6000)!
    expect(s.startupMs).toBe(600)
    expect(s.rebufferCount).toBe(1)
    expect(s.rebufferMs).toBe(500)
    expect(s.rebufferRatio).toBeCloseTo(500 / 4400)
    expect(s.switches).toBe(1)
    // 1 Mbps for 2.5 s, 3 Mbps for 2 s
    expect(s.avgBitrateKbps).toBeCloseTo((1000 * 2500 + 3000 * 2000) / 4500)
  })

  it('counts a still-open rebuffer up to now', () => {
    const events = [ev(0, 'load-start'), ev(100, 'first-frame'), ev(1000, 'buffering-start')]
    expect(summarize(events, 0, 1600)!.rebufferMs).toBe(600)
  })

  it('aggregates segment requests only', () => {
    const events = [
      ev(0, 'load-start'),
      ev(10, 'request', { kind: 'segment', latencyMs: 100, bytes: 100_000 }),
      ev(20, 'request', { kind: 'segment', latencyMs: 300, bytes: 300_000 }),
      ev(30, 'request', { kind: 'manifest', latencyMs: 999, bytes: 1 }),
    ]
    const s = summarize(events, 0, 100)!
    expect(s.requests).toBe(3)
    expect(s.meanSegmentLatencyMs).toBe(200)
    expect(s.throughputKbps).toBeCloseTo((400_000 * 8) / 400)
  })

  it('only looks at the latest load of the requested slot', () => {
    const events = [
      ev(0, 'load-start'),
      ev(50, 'error', {}),
      ev(100, 'load-start'),
      ev(120, 'first-frame'),
      ev(10, 'error', {}, 1),
    ]
    const s = summarize(events, 0, 200)!
    expect(s.errors).toBe(0)
    expect(s.startupMs).toBe(20)
  })
})

describe('Telemetry store', () => {
  it('keeps the log bounded', () => {
    const t = new Telemetry()
    for (let i = 0; i < 5200; i++) {
      t.record({ slot: 0, streamId: 'x', delivery: 'direct', type: 'sample', data: { i } })
    }
    expect(t.getEvents().length).toBe(5000)
    expect(t.getEvents()[0].data.i).toBe(200)
  })
})

describe('toCSV', () => {
  it('quotes the data column', () => {
    const csv = toCSV([ev(1, 'error', { msg: 'a "b", c' })])
    expect(csv.split('\n')[1]).toBe('1.0,0,bbb,direct,error,"{""msg"":""a \\""b\\"", c""}"')
  })
})
