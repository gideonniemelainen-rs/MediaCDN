import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RUNGS, formatRungs, selectRungs } from './ladder.mjs'
import { DEFAULT_IMAGE, explainPackagerFailure, packageCommand, packagerKind } from './packagers.mjs'
import { parseRungsLine, verifyPackage } from './package.mjs'

test('the ladder never upscales and always keeps a rung at or below 360p', () => {
  assert.deepEqual(selectRungs(1080).map((r) => r.height), [240, 360, 480, 720, 1080])
  assert.deepEqual(selectRungs(720).map((r) => r.height), [240, 360, 480, 720])
  assert.deepEqual(selectRungs(1440).map((r) => r.height), [240, 360, 480, 720, 1080], 'taller sources stop at the top rung')
  for (const h of [240, 360, 540, 720, 2160]) assert.ok(selectRungs(h).some((r) => r.height <= 360), `${h}`)
})

test('a source smaller than every rung gets one at its own height', () => {
  assert.deepEqual(selectRungs(144), [{ height: 144, kbps: 800 }])
  assert.deepEqual(selectRungs(200).map((r) => r.height), [200])
})

test('quick keeps 360p and 720p only', () => {
  assert.deepEqual(selectRungs(1080, { quick: true }).map((r) => r.height), [360, 720])
  assert.deepEqual(selectRungs(480, { quick: true }).map((r) => r.height), [360])
})

test('the ladder matches the heights and bitrates scripts/package.sh uses', () => {
  assert.deepEqual(RUNGS.map((r) => `${r.height}:${r.kbps}`), ['240:400', '360:800', '480:1400', '720:2800', '1080:5000'])
})

test('rungs round-trip through the script argument and the log line the stage parses', () => {
  const rungs = selectRungs(720)
  assert.equal(formatRungs(rungs), '240:400 360:800 480:1400 720:2800')
  assert.deepEqual(parseRungsLine(`packaging x (source 720p) -> rungs:${formatRungs(rungs)}`), rungs)
})

test('PIPELINE_PACKAGER accepts the known packagers and refuses a typo', () => {
  assert.equal(packagerKind(undefined), 'ffmpeg')
  assert.equal(packagerKind(''), 'ffmpeg')
  assert.equal(packagerKind('shaka'), 'shaka')
  assert.throws(() => packagerKind('shakka'), /must be one of ffmpeg, shaka/)
})

const base = {
  mezzanine: '/work/abc/mezzanine.mkv', stage: '/origin/.tmp-1', outputId: 'ugc-demo', rungs: selectRungs(720), sourceHeight: 720,
  scriptsDir: '/repo/pipeline/scripts', packageScript: '/repo/scripts/package.sh',
}

test('the ffmpeg packager runs package.sh on the host with the same environment as before', () => {
  const c = packageCommand({ ...base, kind: 'ffmpeg', env: { PATH: '/bin' } })
  assert.equal(c.cmd, 'bash')
  assert.deepEqual(c.args, ['/repo/scripts/package.sh', 'ugc-demo'])
  assert.deepEqual(c.env, { PATH: '/bin', INPUT: '/work/abc/mezzanine.mkv', OUT: '/origin/.tmp-1', PROGRESS: 'pipe:1' })
})

test('the shaka packager runs the worker image with no network, no capabilities and the host user', () => {
  const c = packageCommand({ ...base, kind: 'shaka', uid: 501, gid: 20 })
  assert.equal(c.cmd, 'docker')
  const a = c.args.join(' ')
  assert.match(a, /^run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user 501:20 /)
  assert.ok(a.includes(`-v /work/abc:/in:ro`), 'the mezzanine directory is read-only')
  assert.ok(a.includes('-v /origin/.tmp-1:/out'))
  assert.ok(a.includes('-v /repo/pipeline/scripts:/scripts:ro'))
  assert.ok(a.includes('-e INPUT=/in/mezzanine.mkv') && a.includes('-e OUT=/out') && a.includes('-e PROGRESS=pipe:1'))
  assert.ok(a.includes('-e RUNGS=240:400 360:800 480:1400 720:2800') && a.includes('-e SRC_H=720') && a.includes('-e SLUG=ugc-demo'))
  assert.ok(a.endsWith(`--entrypoint bash ${DEFAULT_IMAGE} /scripts/package-shaka.sh`))
})

test('the image can be overridden, and the user flag is left out where there is no uid', () => {
  const c = packageCommand({ ...base, kind: 'shaka', image: 'registry.example/worker:1' })
  assert.ok(!c.args.includes('--user'))
  assert.ok(c.args.includes('registry.example/worker:1'))
})

test('the host paths are passed as separate arguments, never through a shell', () => {
  const c = packageCommand({ ...base, kind: 'shaka', stage: '/origin/.tmp-1; rm -rf /' })
  assert.ok(c.args.includes('/origin/.tmp-1; rm -rf /:/out'))
})

test('failures say how to fix a setup problem, and otherwise show the last output', () => {
  assert.match(explainPackagerFailure('shaka', { spawnError: { code: 'ENOENT' } }), /docker was not found/)
  assert.match(explainPackagerFailure('shaka', { code: 125, stderrTail: ["Unable to find image 'x' locally"] }), /docker build -t mediacdn-pipeline:dev/)
  assert.match(explainPackagerFailure('shaka', { code: 125, stderrTail: ['Cannot connect to the Docker daemon at unix:///x'] }), /Docker is not running/)
  assert.equal(explainPackagerFailure('shaka', { code: 1, stderrTail: ['a', 'b', 'c', 'd'] }), 'b | c | d')
  assert.equal(explainPackagerFailure('ffmpeg', { code: 1, stderrTail: [] }), 'package.sh exited 1')
  assert.equal(explainPackagerFailure('shaka', { code: 1, stderrTail: [] }), 'package-shaka.sh exited 1')
  assert.doesNotMatch(explainPackagerFailure('ffmpeg', { spawnError: { code: 'ENOENT', message: 'spawn bash ENOENT' } }), /docker/)
})

test('verify also requires a finished HLS playlist and a static DASH manifest', () => {
  const files = ['master.m3u8', 'manifest.mpd', 'media_0.m3u8', 'media_1.m3u8', 'init-0.m4s', 'init-1.m4s', 'chunk-0-00001.m4s', 'chunk-1-00001.m4s']
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="media_1.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nmedia_0.m3u8\n'
  const pl = (n, end = true) => `#EXTM3U\n#EXT-X-MAP:URI="init-${n}.m4s"\n#EXTINF:4.0,\nchunk-${n}-00001.m4s\n${end ? '#EXT-X-ENDLIST\n' : ''}`
  const ok = verifyPackage({ id: 'ugc-x', files, master, playlists: { 'media_0.m3u8': pl(0), 'media_1.m3u8': pl(1) }, mpd: '<MPD type="static">' })
  assert.deepEqual(ok.checks.filter((c) => !c.ok), [])
  const live = verifyPackage({ id: 'ugc-x', files, master, playlists: { 'media_0.m3u8': pl(0), 'media_1.m3u8': pl(1, false) }, mpd: '<MPD type="static">' })
  assert.deepEqual(live.checks.filter((c) => !c.ok).map((c) => c.name), ['HLS playlists are complete (VOD)'])
  const dynamic = verifyPackage({ id: 'ugc-x', files, master, playlists: { 'media_0.m3u8': pl(0), 'media_1.m3u8': pl(1) }, mpd: '<MPD type="dynamic" minimumUpdatePeriod="PT2S">' })
  assert.deepEqual(dynamic.checks.filter((c) => !c.ok).map((c) => c.name), ['DASH manifest is static'])
  const noMpdRead = verifyPackage({ id: 'ugc-x', files, master, playlists: { 'media_0.m3u8': pl(0), 'media_1.m3u8': pl(1) } })
  assert.ok(!noMpdRead.checks.some((c) => c.name === 'DASH manifest is static'), 'only checked when the manifest was read')
})
