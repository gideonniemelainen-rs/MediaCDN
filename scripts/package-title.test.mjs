import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DASH_MANIFEST, HLS_MASTER, chunk, initSegment, isTitleFile, mediaPlaylist } from '../shared/src/title-layout.ts'
import { parseArgs } from './package-title.mjs'

const script = fileURLToPath(new URL('./package-title.mjs', import.meta.url))
const has = (cmd) => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0
const skip = has('ffmpeg') && has('ffprobe') ? false : 'ffmpeg/ffprobe not installed'

test('parseArgs takes a slug and an optional --quick, and refuses anything else', () => {
  assert.deepEqual(parseArgs(['bbb']), { slug: 'bbb', quick: false })
  assert.deepEqual(parseArgs(['--quick', 'ads/spot-15']), { slug: 'ads/spot-15', quick: true })
  assert.throws(() => parseArgs([]), /usage/)
  assert.throws(() => parseArgs(['a', 'b']), /usage/)
  assert.throws(() => parseArgs(['a', '--fast']), /usage/)
})

// The contract test for the ffmpeg packager: ffmpeg fixes some names itself (the HLS playlists are always
// media_<n>.m3u8), so this is what notices if the muxer ever changes them out from under the layout module.
function assertLayout(out, representations) {
  const files = readdirSync(out)
  const unknown = files.filter((f) => !isTitleFile(f))
  assert.deepEqual(unknown, [], 'every file written is a name the layout module knows')
  const expected = [HLS_MASTER, DASH_MANIFEST]
  for (let rep = 0; rep < representations; rep++) expected.push(mediaPlaylist(rep), initSegment(rep), chunk(rep, 1))
  for (const name of expected) assert.ok(files.includes(name), `${name} was written`)
}

test('it picks the rungs for the source height and runs package.sh with them', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'package-title-'))
  try {
    const input = join(dir, 'clip.mp4')
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input])
    const mediaFiles = (out) => readdirSync(out).filter((f) => /^media_\d+\.m3u8$/.test(f)).length
    // Audio is one more playlist than there are video rungs.
    for (const [flags, videoRungs] of [[[], 4], [['--quick'], 2]]) {
      const out = join(dir, `out${flags.length}`)
      const r = spawnSync('node', [script, 'demo', ...flags], { env: { ...process.env, INPUT: input, OUT: out }, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(mediaFiles(out), videoRungs + 1, `${flags.join(' ') || 'full'} ladder`)
      assert.ok(readdirSync(out).includes(HLS_MASTER) && readdirSync(out).includes(DASH_MANIFEST))
      assertLayout(out, videoRungs + 1)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
