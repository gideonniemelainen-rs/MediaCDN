// Live simulation: turns a packaged VOD media playlist into a sliding-window live playlist that
// loops forever. Pure functions, no I/O, so they can be tested with fixed clocks. Playlists are parsed by
// shared/src/title-layout.ts (parseMediaPlaylist), which also owns the live segment names.

import { liveSegment, parseLiveSegment } from '../shared/src/title-layout.ts'

const WINDOW = 5

/**
 * The live playlist at `nowMs` for a stream that started at `epochMs`. Sequence number `seq` maps
 * to VOD segment `seq % M`; each wrap of the loop carries an EXT-X-DISCONTINUITY because the
 * media timestamps restart. Segment URIs are `live<rep>-<seq>.m4s` (`liveSegment`) so every loop iteration is unique
 * on the wire (and therefore independently cacheable); `liveSegmentFile` maps them back.
 */
export function buildLivePlaylist(parsed, epochMs, nowMs, rep) {
  const { segments, init } = parsed
  const M = segments.length
  const starts = []
  let loopLen = 0
  for (const s of segments) {
    starts.push(loopLen)
    loopLen += s.duration
  }

  const elapsed = Math.max(0, (nowMs - epochMs) / 1000)
  const loop = Math.floor(elapsed / loopLen)
  const offset = elapsed - loop * loopLen
  // Latest segment that has fully "happened" by now.
  let done = 0
  while (done < M && starts[done] + segments[done].duration <= offset) done++
  const latest = loop * M + done - 1
  const first = Math.max(0, latest - WINDOW + 1)
  if (latest < 0) return { text: '', latest, first }

  const target = Math.ceil(Math.max(...segments.map((s) => s.duration)))
  const out = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${target}`,
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    // Discontinuities already dropped out of the window: one before every wrap segment s (s > 0,
    // s % M === 0) that is older than the first segment.
    `#EXT-X-DISCONTINUITY-SEQUENCE:${first > 0 ? Math.floor((first - 1) / M) : 0}`,
  ]
  if (init) out.push(`#EXT-X-MAP:URI="${init}"`)
  for (let seq = first; seq <= latest; seq++) {
    const idx = seq % M
    const iter = Math.floor(seq / M)
    if (idx === 0 && seq > 0) out.push('#EXT-X-DISCONTINUITY')
    out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(epochMs + (iter * loopLen + starts[idx]) * 1000).toISOString()}`)
    out.push(`#EXTINF:${segments[idx].duration.toFixed(3)},`)
    out.push(liveSegment(rep, seq))
  }
  return { text: out.join('\n') + '\n', latest, first }
}

/** Maps a live segment URI (`live<rep>-<seq>.m4s`) to the VOD segment URI it stands for. */
export function liveSegmentFile(parsed, uri, rep) {
  const m = parseLiveSegment(uri)
  if (!m || m.rep !== rep) return null
  return parsed.segments[m.seq % parsed.segments.length].uri
}
