import { describe, expect, it } from 'vitest'
import { normaliseTransport, pickTiming, type TimingEntry } from './transport'

const entry = (over: Partial<TimingEntry> = {}): TimingEntry => ({
  name: 'https://cdn.test/seg-1.m4s',
  responseEnd: 1000,
  connectStart: 0,
  connectEnd: 0,
  requestStart: 900,
  responseStart: 950,
  nextHopProtocol: 'h2',
  transferSize: 5000,
  ...over,
})

describe('normaliseTransport', () => {
  it('maps the protocol names the browser reports', () => {
    expect(normaliseTransport('http/1.1')).toBe('h1')
    expect(normaliseTransport('h2')).toBe('h2')
    expect(normaliseTransport('h3')).toBe('h3')
    expect(normaliseTransport('h3-29')).toBe('h3')
  })

  it('is unknown when the browser hides it or does not say', () => {
    expect(normaliseTransport('')).toBe('unknown')
    expect(normaliseTransport(undefined)).toBe('unknown')
    expect(normaliseTransport('spdy/3')).toBe('unknown')
  })
})

describe('pickTiming', () => {
  it('reads protocol, connect time and time to first byte', () => {
    const t = pickTiming([entry({ connectStart: 800, connectEnd: 860 })], 'https://cdn.test/seg-1.m4s', 1001)
    expect(t).toEqual({ transport: 'h2', connectMs: 60, ttfbMs: 50, httpCache: false })
  })

  it('reports a reused connection as 0 ms connect', () => {
    expect(pickTiming([entry()], 'https://cdn.test/seg-1.m4s', 1001)?.connectMs).toBe(0)
  })

  it('treats a cross-origin entry without Timing-Allow-Origin as unknown, with no timings', () => {
    const hidden = entry({ nextHopProtocol: '', requestStart: 0, responseStart: 0 })
    expect(pickTiming([hidden], hidden.name, 1001)).toEqual({ transport: 'unknown', connectMs: null, ttfbMs: null, httpCache: false })
  })

  it('recognises a response from the HTTP cache, whether the protocol is empty (HTTP) or the original one (HTTPS)', () => {
    const plain = entry({ nextHopProtocol: '', transferSize: 0, connectStart: 5, connectEnd: 5 })
    expect(pickTiming([plain], plain.name, 1001)).toEqual({ transport: 'unknown', connectMs: null, ttfbMs: null, httpCache: true })
    const secure = entry({ nextHopProtocol: 'h2', transferSize: 0 })
    expect(pickTiming([secure], secure.name, 1001)).toEqual({ transport: 'h2', connectMs: null, ttfbMs: null, httpCache: true })
  })

  it('returns null when no entry has that name', () => {
    expect(pickTiming([entry()], 'https://cdn.test/other.m4s', 1001)).toBeNull()
  })

  it('picks the nearest of several range requests to one URL, and never gives one entry out twice', () => {
    const early = entry({ responseEnd: 400, nextHopProtocol: 'http/1.1' })
    const late = entry({ responseEnd: 1000, nextHopProtocol: 'h3' })
    const claimed = new Set<TimingEntry>()
    expect(pickTiming([early, late], early.name, 1001, claimed)?.transport).toBe('h3')
    expect(pickTiming([early, late], early.name, 1001, claimed)?.transport).toBe('h1')
    expect(pickTiming([early, late], early.name, 1001, claimed)).toBeNull()
  })

  it('ignores an entry from an earlier load of the same URL', () => {
    const old = entry({ responseEnd: 100 })
    expect(pickTiming([old], old.name, 20_000)).toBeNull()
  })

  it('ignores an entry that finishes after the response was seen', () => {
    expect(pickTiming([entry({ responseEnd: 5000 })], 'https://cdn.test/seg-1.m4s', 1000)).toBeNull()
  })
})
