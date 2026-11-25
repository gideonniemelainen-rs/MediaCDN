import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DASH_MANIFEST, HLS_MASTER, TEMPLATES, buildIndex, chunk, expandTemplate, indexLocation, initSegment, isSafeId, isTitleFile,
  liveLocation, liveSegment, mediaPlaylist, mediaPlaylistRep, parseIndex, parseLivePath, parseLiveSegment, parseMediaPlaylist, titleLocation,
} from './title-layout.ts'

test('file names follow the layout the packagers write', () => {
  assert.equal(mediaPlaylist(3), 'media_3.m3u8')
  assert.equal(initSegment(0), 'init-0.m4s')
  assert.equal(chunk(2, 7), 'chunk-2-00007.m4s')
  assert.equal(chunk(1, 12345), 'chunk-1-12345.m4s')
  assert.equal(liveSegment(1, 42), 'live1-42.m4s')
})

test('parsers read back what the builders write, and refuse anything else', () => {
  assert.equal(mediaPlaylistRep(mediaPlaylist(4)), 4)
  for (const bad of ['media_.m3u8', 'media_1.m3u8.bak', 'xmedia_1.m3u8', 'master.m3u8']) assert.equal(mediaPlaylistRep(bad), null, bad)
  assert.deepEqual(parseLiveSegment(liveSegment(2, 99)), { rep: 2, seq: 99 })
  for (const bad of ['live-5.m4s', 'live1-x.m4s', 'chunk-1-00001.m4s', 'live1-5.m4s.tmp']) assert.equal(parseLiveSegment(bad), null, bad)
})

test('isTitleFile accepts what a packager writes and nothing else', () => {
  for (const ok of [HLS_MASTER, DASH_MANIFEST, mediaPlaylist(0), initSegment(3), chunk(0, 1)]) assert.equal(isTitleFile(ok), true, ok)
  // source.json is added by publish, and live segments are the origin's, so neither is a packager output.
  for (const no of ['source.json', 'ad.mp4', liveSegment(0, 1), 'media_.m3u8', '.rungs', 'init-0.mp4']) assert.equal(isTitleFile(no), false, no)
})

test('the templates expand to exactly the names the builders give', () => {
  for (const rep of [0, 1, 5]) {
    assert.equal(expandTemplate(TEMPLATES.init, rep), initSegment(rep))
    assert.equal(expandTemplate(TEMPLATES.playlist, rep), mediaPlaylist(rep))
    for (const n of [1, 9, 123, 99999]) assert.equal(expandTemplate(TEMPLATES.chunk, rep, n), chunk(rep, n))
  }
})

test('ids are safe slugs', () => {
  for (const ok of ['bbb', 'ugc-demo', 'a1', '0x']) assert.equal(isSafeId(ok), true, ok)
  for (const bad of ['', '-a', 'A', 'a b', '../x', 'a/b', 'a_b', 'ads/spot-15']) assert.equal(isSafeId(bad), false, bad)
})

test('locations build from a delivery prefix', () => {
  assert.equal(titleLocation('', 'bbb', 'hls'), '/bbb/master.m3u8')
  assert.equal(titleLocation('/s3', 'bbb', 'dash'), '/s3/bbb/manifest.mpd')
  assert.equal(liveLocation('bbb'), '/live/bbb/master.m3u8')
  assert.equal(indexLocation('http://localhost:8788', ''), 'http://localhost:8788/index.json')
  assert.equal(indexLocation('https://cdn.example', '/s3'), 'https://cdn.example/s3/index.json')
})

test('the live route parses a slug and a file, and refuses a path that climbs', () => {
  assert.deepEqual(parseLivePath('live/bbb/media_0.m3u8'), { slug: 'bbb', file: 'media_0.m3u8' })
  assert.deepEqual(parseLivePath('live/ugc-demo/live1-3.m4s'), { slug: 'ugc-demo', file: 'live1-3.m4s' })
  for (const bad of ['live/bbb', 'live//x.m3u8', 'live/../x/y.m3u8', 'bbb/master.m3u8', 'live/a/b/c.m3u8']) assert.equal(parseLivePath(bad), null, bad)
})

const NOW = new Date('2026-01-01T00:00:00Z')

test('buildIndex lists titles with the protocols they have, sorted by id', () => {
  const idx = buildIndex(
    [
      { slug: 'bbb', files: [HLS_MASTER, DASH_MANIFEST, mediaPlaylist(0)] },
      { slug: 'agent-327', files: [HLS_MASTER] },
      { slug: 'dash-only', files: [DASH_MANIFEST] },
    ],
    { now: NOW },
  )
  assert.equal(idx.version, 1)
  assert.equal(idx.generatedAt, NOW.toISOString())
  assert.deepEqual(idx.titles, [
    { id: 'agent-327', protocols: ['hls'] },
    { id: 'bbb', protocols: ['hls', 'dash'] },
    { id: 'dash-only', protocols: ['dash'] },
  ])
})

test('buildIndex skips folders without a manifest and ids that are not safe slugs', () => {
  const idx = buildIndex(
    [
      { slug: 'empty', files: [chunk(0, 1)] },
      { slug: 'Bad_Name', files: [HLS_MASTER] },
      { slug: '../x', files: [HLS_MASTER] },
    ],
    { now: NOW },
  )
  assert.deepEqual(idx.titles, [])
})

test('buildIndex flags live only for HLS titles, and only when the origin can simulate it', () => {
  const listing = [
    { slug: 'a', files: [HLS_MASTER] },
    { slug: 'b', files: [DASH_MANIFEST] },
  ]
  assert.deepEqual(buildIndex(listing, { live: true, now: NOW }).titles, [
    { id: 'a', protocols: ['hls'], live: true },
    { id: 'b', protocols: ['dash'] },
  ])
  assert.deepEqual(buildIndex(listing, { now: NOW }).titles[0], { id: 'a', protocols: ['hls'] })
})

test('parseIndex accepts a valid index and drops unsafe ids and unknown protocols', () => {
  const idx = parseIndex({
    version: 1,
    titles: [
      { id: 'ok', protocols: ['hls', 'smooth'] },
      { id: '../evil', protocols: ['hls'] },
      { id: 'none', protocols: ['smooth'] },
      { id: 'x', protocols: 'hls' },
    ],
  })
  assert.deepEqual(idx.titles, [{ id: 'ok', protocols: ['hls'] }])
})

test('parseIndex rejects documents that are not an index', () => {
  assert.throws(() => parseIndex({ titles: [] }), /not a title index/)
  assert.throws(() => parseIndex(null))
  assert.throws(() => parseIndex({ version: 2, titles: [] }))
})

test('the index the origin writes is the index the app reads', () => {
  const written = buildIndex(
    [
      { slug: 'bbb', files: [HLS_MASTER, DASH_MANIFEST] },
      { slug: 'ugc-demo', files: [HLS_MASTER] },
      { slug: 'not_safe', files: [HLS_MASTER] },
    ],
    { live: true, now: NOW },
  )
  // Over the wire it is JSON, so go through it.
  assert.deepEqual(parseIndex(JSON.parse(JSON.stringify(written))), written)
})

const VOD = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MAP:URI="init-0.m4s"
#EXTINF:4.000000,
chunk-0-00001.m4s
#EXTINF:3.500000,
chunk-0-00002.m4s
#EXT-X-ENDLIST
`

test('parseMediaPlaylist reads the init segment, durations and URIs', () => {
  const p = parseMediaPlaylist(VOD)
  assert.equal(p.init, initSegment(0))
  assert.deepEqual(p.segments, [{ uri: chunk(0, 1), duration: 4 }, { uri: chunk(0, 2), duration: 3.5 }])
  assert.equal(parseMediaPlaylist(VOD.replace(/\n/g, '\r\n')).segments.length, 2)
})

test('parseMediaPlaylist has no init when the playlist has none, and refuses a playlist without segments', () => {
  assert.equal(parseMediaPlaylist('#EXTM3U\n#EXTINF:2,\na.m4s\n').init, null)
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-ENDLIST\n'), /no segments/)
})
