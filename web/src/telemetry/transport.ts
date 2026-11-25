/** The HTTP version a request was actually served over, as the browser reports it. (The catalog's `Transport` is the one asked for.) */
export type ObservedTransport = 'h1' | 'h2' | 'h3' | 'unknown'

/** The slice of PerformanceResourceTiming this module reads. */
export interface TimingEntry {
  name: string
  responseEnd: number
  connectStart: number
  connectEnd: number
  requestStart: number
  responseStart: number
  nextHopProtocol: string
}

export interface TransportTiming {
  transport: ObservedTransport
  /** Connection setup time; 0 when an existing connection was reused. Null when the browser hid the timings. */
  connectMs: number | null
  /** Request sent to first byte. Null when the browser hid the timings. */
  ttfbMs: number | null
}

/** How far before the response filter ran an entry may have finished and still be its request. */
const MATCH_WINDOW_MS = 5000
/** Entries may finish a hair after the filter's own clock reading. */
const EPSILON_MS = 100

/** Maps `nextHopProtocol` (`h2`, `h3`, `h3-29`, `http/1.1`, or `''` when hidden) to a transport. */
export function normaliseTransport(nextHopProtocol: string | undefined): ObservedTransport {
  const p = (nextHopProtocol ?? '').toLowerCase()
  if (p.startsWith('h3')) return 'h3'
  if (p === 'h2') return 'h2'
  if (p === 'http/1.1' || p === 'http/1.0') return 'h1'
  return 'unknown'
}

/**
 * Finds the resource-timing entry for one response. Range requests share a URL, so among the entries
 * with that name that finished just before `at` (the response filter's performance.now()) this takes the
 * nearest one that is not in `claimed`, and adds it to `claimed` so the next request cannot reuse it.
 */
export function pickTiming(
  entries: readonly TimingEntry[],
  uri: string,
  at: number,
  claimed: Set<TimingEntry> = new Set(),
): TransportTiming | null {
  let best: TimingEntry | null = null
  for (const e of entries) {
    if (e.name !== uri || claimed.has(e)) continue
    if (e.responseEnd > at + EPSILON_MS || e.responseEnd < at - MATCH_WINDOW_MS) continue
    if (!best || Math.abs(at - e.responseEnd) < Math.abs(at - best.responseEnd)) best = e
  }
  if (!best) return null
  claimed.add(best)

  const transport = normaliseTransport(best.nextHopProtocol)
  // Without Timing-Allow-Origin a cross-origin entry reports zeros for everything but the end times.
  const hidden = transport === 'unknown' && best.requestStart === 0
  return {
    transport,
    connectMs: hidden ? null : Math.max(0, best.connectEnd - best.connectStart),
    ttfbMs: hidden || best.responseStart < best.requestStart ? null : best.responseStart - best.requestStart,
  }
}
