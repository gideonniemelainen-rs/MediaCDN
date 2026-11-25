import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMediaPlaylist } from '../shared/src/title-layout.ts'
import { buildLivePlaylist, liveSegmentFile } from './live.mjs'

// Segments of 4, 4 and 3 s: an 11 s loop.
const LOOP = 11
const VOD = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MAP:URI="init-0.m4s"
#EXTINF:4.000000,
chunk-0-00001.m4s
#EXTINF:4.000000,
chunk-0-00002.m4s
#EXTINF:3.000000,
chunk-0-00003.m4s
#EXT-X-ENDLIST
`
const parsed = parseMediaPlaylist(VOD)
const EPOCH = Date.parse('2026-01-01T00:00:00Z')
const at = (s) => buildLivePlaylist(parsed, EPOCH, EPOCH + s * 1000, 0)
const uris = (t) => t.split('\n').filter((l) => l.startsWith('live0-'))

test('nothing is available before the first segment completes', () => {
  assert.equal(at(3.9).text, '')
})

test('window grows from the start and only lists finished segments', () => {
  const p = at(8.5) // segments 0 and 1 done
  assert.deepEqual(uris(p.text), ['live0-0.m4s', 'live0-1.m4s'])
  assert.match(p.text, /#EXT-X-MEDIA-SEQUENCE:0\n/)
  assert.match(p.text, /#EXT-X-DISCONTINUITY-SEQUENCE:0\n/)
  assert.ok(!p.text.includes('#EXT-X-DISCONTINUITY\n'))
})

test('wrapping the loop adds a discontinuity and keeps URIs unique', () => {
  const p = at(LOOP + 4.5) // second loop, first segment done: seq 3 is latest
  assert.equal(p.latest, 3)
  assert.deepEqual(uris(p.text), ['live0-0.m4s', 'live0-1.m4s', 'live0-2.m4s', 'live0-3.m4s'])
  const lines = p.text.split('\n')
  const disc = lines.indexOf('#EXT-X-DISCONTINUITY')
  assert.equal(lines[disc + 2 + 0].startsWith('#EXTINF'), true) // tag, PDT, EXTINF
  assert.equal(lines[disc + 3], 'live0-3.m4s')
})

test('window slides and discontinuity sequence advances once the wrap segment leaves it', () => {
  const p = at(LOOP * 4 + 0.1) // loop 4 just started: latest = seq 11 (loop 3, last segment)
  assert.equal(p.latest, 11)
  assert.equal(p.first, 7)
  // wraps before seq 7 are at 3 and 6, so two discontinuities have left the window
  assert.match(p.text, /#EXT-X-DISCONTINUITY-SEQUENCE:2\n/)
  assert.equal(p.text.split('\n').filter((l) => l === '#EXT-X-DISCONTINUITY').length, 1) // before seq 9
})

test('a window starting exactly on a wrap keeps that segment tag', () => {
  const p = at(LOOP * 2 + 8.1) // latest = seq 7 (loop 2, idx 1), so the window starts at seq 3
  assert.equal(p.latest, 7)
  assert.equal(p.first, 3)
  assert.match(p.text, /#EXT-X-DISCONTINUITY-SEQUENCE:0\n/)
  assert.match(p.text, /#EXT-X-MEDIA-SEQUENCE:3\n/)
  assert.match(p.text, /#EXT-X-MAP:URI="init-0.m4s"\n#EXT-X-DISCONTINUITY\n/)
})

test('program date time follows the loop timeline', () => {
  const p = at(LOOP + 4.5)
  const pdt = p.text.split('\n').filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME'))
  assert.equal(pdt[3], '#EXT-X-PROGRAM-DATE-TIME:' + new Date(EPOCH + LOOP * 1000).toISOString())
})

test('maps live segment URIs back to VOD files', () => {
  assert.equal(liveSegmentFile(parsed, 'live0-0.m4s', 0), 'chunk-0-00001.m4s')
  assert.equal(liveSegmentFile(parsed, 'live0-5.m4s', 0), 'chunk-0-00003.m4s')
  assert.equal(liveSegmentFile(parsed, 'live0-3.m4s', 0), 'chunk-0-00001.m4s')
  assert.equal(liveSegmentFile(parsed, 'evil/../x.m4s', 0), null)
})
