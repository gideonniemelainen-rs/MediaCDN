import { describe, expect, it } from 'vitest'
import type { TelemetryEvent } from '../telemetry/types'
import { summarize } from '../telemetry/metrics'
import { buildRunPayload, describeRun, rebuildRows } from './run'

const ev = (slot: number, type: TelemetryEvent['type'], t: number, over: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
  t, slot, streamId: 'bbb-hls', delivery: slot === 0 ? 'local' : 's3-near', type, data: {}, ...over,
})
const req = (slot: number, t: number, latencyMs: number, bytes: number) => ev(slot, 'request', t, { data: { kind: 'segment', latencyMs, bytes } })

// Slot 0 plays cleanly; slot 1 starts slower and rebuffers once; slots 2 and 3 never played.
const EVENTS: TelemetryEvent[] = [
  ev(0, 'load-start', 100), ev(1, 'load-start', 110),
  ev(0, 'variant-change', 120, { data: { bandwidth: 2_800_000 } }), ev(0, 'first-frame', 140),
  ev(1, 'variant-change', 200, { data: { bandwidth: 1_400_000 } }), ev(1, 'first-frame', 260),
  req(0, 150, 8, 100_000), req(1, 270, 90, 100_000),
  ev(1, 'buffering-start', 1000), ev(1, 'buffering-end', 1500),
  ev(0, 'sample', 2000, { data: { liveLatencyS: null } }),
]
const NOW = 5000
const TIME_ORIGIN = 1_795_000_000_000

describe('buildRunPayload', () => {
  const payload = buildRunPayload({ events: EVENTS, now: NOW, timeOrigin: TIME_ORIGIN, label: '  local vs s3  ', env: { ua: 'x' } })!

  it('has one session per quadrant that played, with its summary', () => {
    expect(payload.sessions.map((s) => [s.slot, s.streamId, s.delivery])).toEqual([[0, 'bbb-hls', 'local'], [1, 'bbb-hls', 's3-near']])
    expect(payload.sessions[0].summary.startupMs).toBe(40)
    expect(payload.sessions[1].summary.rebufferCount).toBe(1)
  })

  it('puts the run on the wall clock and trims the label', () => {
    expect(payload.label).toBe('local vs s3')
    expect(payload.startedAt).toBe(TIME_ORIGIN + 100)
    expect(payload.endedAt).toBe(TIME_ORIGIN + NOW)
    expect(payload.timeOrigin).toBe(TIME_ORIGIN)
    expect(payload.nowMs).toBe(NOW)
  })

  it('keeps the events in time order and only those of the saved sessions', () => {
    expect(payload.events.map((e) => e.t)).toEqual([...payload.events.map((e) => e.t)].sort((a, b) => a - b))
    expect(payload.events).toHaveLength(EVENTS.length)
  })

  it('leaves out events from an earlier session of the same quadrant', () => {
    const replayed = [ev(0, 'load-start', 1), ev(0, 'error', 2), ...EVENTS]
    const p = buildRunPayload({ events: replayed, now: NOW, timeOrigin: TIME_ORIGIN })!
    expect(p.events.some((e) => e.t === 1 || e.t === 2)).toBe(false)
    expect(p.label).toBeUndefined()
  })

  it('keeps the ABR cap that was in force when a session began, though it was set before load-start', () => {
    const withCaps = [ev(0, 'abr-cap', 50, { data: { maxHeight: null } }), ev(1, 'abr-cap', 60, { data: { maxHeight: 360 } }), ...EVENTS]
    const p = buildRunPayload({ events: withCaps, now: NOW, timeOrigin: TIME_ORIGIN })!
    const caps = p.events.filter((e) => e.type === 'abr-cap')
    expect(caps.map((c) => [c.slot, c.data.maxHeight])).toEqual([[0, null], [1, 360]])
    expect(p.startedAt).toBe(TIME_ORIGIN + 100) // the run starts at the first load, not at the cap
    const [s0, s1] = rebuildRows({ events: p.events, nowMs: p.nowMs })
    expect(s0.summary).toEqual(summarize(EVENTS, 0, NOW))
    expect(s1.summary).toEqual(summarize(EVENTS, 1, NOW))
  })

  it('only keeps the cap that preceded the session, not one from an earlier session', () => {
    const p = buildRunPayload({ events: [ev(0, 'abr-cap', 1, { data: { maxHeight: 720 } }), ev(0, 'load-start', 2), ev(0, 'abr-cap', 3, { data: { maxHeight: 360 } }), ...EVENTS.map((e) => ({ ...e, t: e.t + 10 }))], now: NOW, timeOrigin: TIME_ORIGIN })!
    expect(p.events.filter((e) => e.slot === 0 && e.type === 'abr-cap').map((e) => e.data.maxHeight)).toEqual([360])
  })

  it('is null when nothing has played', () => {
    expect(buildRunPayload({ events: [], now: NOW, timeOrigin: TIME_ORIGIN })).toBeNull()
  })
})

describe('rebuildRows', () => {
  it('recomputes exactly the summaries that were saved', () => {
    const payload = buildRunPayload({ events: EVENTS, now: NOW, timeOrigin: TIME_ORIGIN })!
    // Through JSON, as the server stores and returns it.
    const blob = JSON.parse(JSON.stringify({ events: payload.events, nowMs: payload.nowMs }))
    const rebuilt = rebuildRows(blob)
    expect(rebuilt.map((r) => r.slot)).toEqual([0, 1])
    for (const r of rebuilt) {
      expect(r.summary).toEqual(payload.sessions.find((s) => s.slot === r.slot)!.summary)
      expect(r.summary).toEqual(summarize(EVENTS, r.slot, NOW))
    }
  })
})

describe('describeRun', () => {
  const label = (d: string) => ({ local: 'Origin', 's3-near': 'S3 near' })[d] ?? d
  it('groups deliveries under each stream', () => {
    expect(describeRun([{ streamId: 'bbb-hls', delivery: 'local' }, { streamId: 'bbb-hls', delivery: 's3-near' }], label)).toBe('bbb-hls via Origin, S3 near')
    expect(describeRun([{ streamId: 'a', delivery: 'local' }, { streamId: 'b', delivery: 'local' }], label)).toBe('a via Origin; b via Origin')
  })
})
