import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isProgressNoise, parseProgressLine } from './ingest.mjs'
import { chooseOutputId, parseRungsLine, verifyPackage } from './package.mjs'
import { hostAllowed, originAllowed, safeExt } from './server.mjs'

// Shaped like ffmpeg's DASH-muxer HLS output (see origin/bbb).
const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_A1",NAME="audio_2",DEFAULT=YES,CHANNELS="2",URI="media_2.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=931786,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="group_A1"
media_0.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2931786,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_A1"
media_1.m3u8
`
const media = (init, segs, dur = 4) =>
  `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MAP:URI="${init}"\n${segs.map((s) => `#EXTINF:${dur.toFixed(6)},\n#EXT-X-PROGRAM-DATE-TIME:2026-11-12T15:17:20.000-0400\n${s}`).join('\n')}\n#EXT-X-ENDLIST\n`
const good = () => ({
  id: 'ugc-demo',
  files: ['master.m3u8', 'manifest.mpd', 'media_0.m3u8', 'media_1.m3u8', 'media_2.m3u8', 'init-0.m4s', 'init-1.m4s', 'init-2.m4s', 'chunk-0-00001.m4s', 'chunk-1-00001.m4s', 'chunk-2-00001.m4s'],
  master: MASTER,
  playlists: {
    'media_0.m3u8': media('init-0.m4s', ['chunk-0-00001.m4s']),
    'media_1.m3u8': media('init-1.m4s', ['chunk-1-00001.m4s']),
    'media_2.m3u8': media('init-2.m4s', ['chunk-2-00001.m4s']),
  },
})
const failing = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name)

test('verifyPackage passes a complete title and reports its renditions', () => {
  const r = verifyPackage(good())
  assert.deepEqual(failing(r), [])
  assert.equal(r.ok, true)
  assert.deepEqual(r.renditions, [
    { bandwidth: 931786, resolution: '640x360' },
    { bandwidth: 2931786, resolution: '1280x720' },
  ])
})

test('verifyPackage catches each kind of damage', () => {
  const noDash = good()
  noDash.files = noDash.files.filter((f) => f !== 'manifest.mpd')
  assert.deepEqual(failing(verifyPackage(noDash)), ['DASH manifest present', 'Listed by the origin index'])

  const lostSegment = good()
  lostSegment.files = lostSegment.files.filter((f) => f !== 'chunk-1-00001.m4s')
  assert.deepEqual(failing(verifyPackage(lostSegment)), ['All segments present'])

  const lostPlaylist = good()
  delete lostPlaylist.playlists['media_1.m3u8']
  assert.deepEqual(failing(verifyPackage(lostPlaylist)), ['Media playlists present'])

  const noAudio = good()
  noAudio.master = noAudio.master.split('\n').filter((l) => !l.startsWith('#EXT-X-MEDIA')).join('\n')
  assert.deepEqual(failing(verifyPackage(noAudio)), ['Audio rendition in master'])

  const longSegments = good()
  longSegments.playlists['media_0.m3u8'] = media('init-0.m4s', ['chunk-0-00001.m4s'], 12)
  assert.deepEqual(failing(verifyPackage(longSegments)), ['Segment length'])

  const empty = { id: 'ugc-demo', files: [], master: '', playlists: {} }
  assert.equal(verifyPackage(empty).ok, false)
})

test('parseRungsLine reads package.sh output', () => {
  assert.deepEqual(parseRungsLine('packaging ugc-demo (source 1080p) -> rungs: 240:400 360:800 1080:5000'), [
    { height: 240, kbps: 400 },
    { height: 360, kbps: 800 },
    { height: 1080, kbps: 5000 },
  ])
  assert.equal(parseRungsLine('done: 12 files, 3.1M'), null)
})

test('the key=value lines of ffmpeg -progress are noise, padded or not, and real log lines are not', () => {
  for (const l of ['frame=112', 'fps=0.0', 'bitrate=   0.1kbits/s', 'bitrate=N/A', 'speed=7.83x', 'speed=   1x', 'total_size=0', 'progress=continue', 'out_time=00:00:03.910000', 'stream_0_0_q=22.0'])
    assert.equal(isProgressNoise(l), true, l)
  for (const l of ['packaging x (source 720p) -> rungs:240:400', 'done: 37 files, 14M', 'WARNING: something odd', 'Error = bad thing happened', ''])
    assert.equal(isProgressNoise(l), false, l)
})

test('parseProgressLine turns ffmpeg -progress output into a fraction', () => {
  assert.equal(parseProgressLine('out_time_us=5000000', 10), 0.5)
  assert.equal(parseProgressLine('out_time_ms=5000000', 10), 0.5)
  assert.equal(parseProgressLine('out_time_us=99000000', 10), 1)
  assert.equal(parseProgressLine('out_time_us=100', 0), null)
  assert.equal(parseProgressLine('out_time_us=N/A', 10), null)
  assert.equal(parseProgressLine('progress=end', 10), 1)
  assert.equal(parseProgressLine('frame=120', 10), null)
})

test('chooseOutputId namespaces uploads and avoids clobbering other titles', () => {
  const sha = 'abcdef0123456789'
  assert.equal(chooseOutputId('demo', sha, new Map()), 'ugc-demo')
  // Same content uploaded again: overwrite its own title.
  assert.equal(chooseOutputId('demo', sha, new Map([['ugc-demo', sha]])), 'ugc-demo')
  // Different content, same name: suffix from the sha.
  assert.equal(chooseOutputId('demo', sha, new Map([['ugc-demo', 'ffff']])), 'ugc-demo-abcdef')
  // A directory with no recorded owner is never overwritten.
  assert.equal(chooseOutputId('demo', sha, new Map([['ugc-demo', null]])), 'ugc-demo-abcdef')
  assert.equal(chooseOutputId('x'.repeat(200), sha, new Map()).length <= 60, true)
})

test('server guards: host, origin and stored extension', () => {
  assert.equal(hostAllowed('localhost:8790'), true)
  assert.equal(hostAllowed('127.0.0.1:8790'), true)
  assert.equal(hostAllowed('evil.example:8790'), false)
  assert.equal(hostAllowed('localhost.evil.example'), false)
  assert.equal(hostAllowed(undefined), false)
  const allowed = ['http://localhost:5173']
  assert.equal(originAllowed(undefined, allowed), true)
  assert.equal(originAllowed('http://localhost:5173', allowed), true)
  assert.equal(originAllowed('https://evil.example', allowed), false)
  assert.equal(safeExt('Screen Recording.MOV'), '.mov')
  assert.equal(safeExt('weird.ext/../../x'), '')
  assert.equal(safeExt('noext'), '')
})
