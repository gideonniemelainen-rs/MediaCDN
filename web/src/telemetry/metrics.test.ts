import { describe, expect, it } from 'vitest'
import { Telemetry } from './store'
import { capOf, dominantTransport, summarize, summarizeByTransport, toCSV, type Summary } from './metrics'
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
    expect(csv.split('\n')[1]).toBe('1.0,0,bbb,direct,,error,"{""msg"":""a \\""b\\"", c""}"')
  })

  it('has a transport column, filled for requests only', () => {
    const csv = toCSV([ev(1, 'request', { kind: 'segment', transport: 'h3' }), ev(2, 'sample', { transport: 'h3' })]).split('\n')
    expect(csv[0]).toBe('t_ms,slot,stream,delivery,transport,type,data')
    expect(csv[1].startsWith('1.0,0,bbb,direct,h3,request,')).toBe(true)
    expect(csv[2].startsWith('2.0,0,bbb,direct,,sample,')).toBe(true)
  })
})

const req = (t: number, data: Record<string, unknown>, slot = 0) => ev(t, 'request', { kind: 'segment', bytes: 1000, latencyMs: 10, ...data }, slot)

describe('observed transport', () => {
  it('is the protocol most requests used, unknown when none reported one, and null with no requests', () => {
    expect(dominantTransport([])).toBeNull()
    expect(dominantTransport([req(1, { transport: 'h2' }), req(2, { transport: 'h3' }), req(3, { transport: 'h3' })])).toBe('h3')
    expect(dominantTransport([req(1, { transport: 'unknown' }), req(2, {})])).toBe('unknown')
    expect(dominantTransport([req(1, { transport: 'unknown' }), req(2, { transport: 'h2' })])).toBe('h2')
    expect(dominantTransport([req(1, { transport: 'h1' }), req(2, { transport: 'h1' }), req(3, { transport: 'h2' })])).toBe('h1')
  })

  it('goes into the summary with mean time to first byte and mean connect time over new connections only', () => {
    const s = summarize(
      [
        ev(0, 'load-start'),
        req(1, { transport: 'h3', ttfbMs: 4, connectMs: 30 }),
        req(2, { transport: 'h3', ttfbMs: 6, connectMs: 0 }),
        req(3, { transport: 'h3', ttfbMs: null, connectMs: null }),
      ],
      0,
      10,
    )!
    expect(s.transport).toBe('h3')
    expect(s.meanTtfbMs).toBe(5)
    expect(s.meanConnectMs).toBe(30)
  })

  it('leaves the figures null when the browser hid them', () => {
    const s = summarize([ev(0, 'load-start'), req(1, { transport: 'unknown', ttfbMs: null, connectMs: null })], 0, 10)!
    expect(s.transport).toBe('unknown')
    expect(s.meanTtfbMs).toBeNull()
    expect(s.meanConnectMs).toBeNull()
  })
})

describe('summarizeByTransport', () => {
  const sum = (transport: Summary['transport'], over: Partial<Summary> = {}): Summary => ({
    startupMs: 100, rebufferCount: 0, rebufferMs: 0, rebufferRatio: 0, switches: 0, avgBitrateKbps: 1000, errors: 0, requests: 5,
    meanSegmentLatencyMs: 20, throughputKbps: 4000, liveLatencyS: null, transport, meanTtfbMs: 5, meanConnectMs: null, ...over,
  })

  it('groups by delivery and observed protocol, averaging over the group', () => {
    const groups = summarizeByTransport([
      { delivery: 'local', summary: sum('h2', { startupMs: 100 }) },
      { delivery: 'local', summary: sum('h2', { startupMs: 200 }) },
      { delivery: 'local', summary: sum('h3', { startupMs: 50, meanConnectMs: 12 }) },
      { delivery: 's3-near', summary: sum('unknown') },
    ])
    expect(groups.map((g) => `${g.delivery}/${g.transport}/${g.quadrants}`)).toEqual(['local/h2/2', 'local/h3/1', 's3-near/unknown/1'])
    expect(groups[0].startupMs).toBe(150)
    expect(groups[1].meanConnectMs).toBe(12)
    expect(groups[0].meanConnectMs).toBeNull()
  })

  it('skips idle quadrants and ones with no requests yet', () => {
    expect(summarizeByTransport([{ delivery: 'local', summary: null }, { delivery: 'local', summary: sum(null) }])).toEqual([])
  })
})

describe('capOf', () => {
  it('is the last cap recorded for the quadrant, null when uncapped (Infinity live, null from JSON), undefined when none', () => {
    const cap = (t: number, slot: number, maxHeight: number | null) => ev(t, 'abr-cap', { maxHeight }, slot)
    expect(capOf([], 0)).toBeUndefined()
    expect(capOf([cap(1, 0, 360), cap(2, 0, Infinity)], 0)).toBeNull()
    expect(capOf([cap(1, 0, Infinity), cap(2, 0, 360), cap(3, 1, null)], 0)).toBe(360)
    expect(capOf([cap(1, 1, null)], 1)).toBeNull()
    expect(capOf([cap(1, 1, 360)], 0)).toBeUndefined()
  })
})
