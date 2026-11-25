// Both packaging scripts take the ladder from the caller and hold no bitrate table or arithmetic of their own.
// PRINT_ARGS=1 makes each print its ffmpeg arguments and stop, so this runs without encoding anything. The
// rung values below are deliberately not ones either script could produce itself (no 1.5x or 2x anywhere).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { encodeSpec, selectRungs } from '../../shared/src/ladder.ts'

const FFMPEG_SCRIPT = fileURLToPath(new URL('../../scripts/package.sh', import.meta.url))
const SHAKA_SCRIPT = fileURLToPath(new URL('../scripts/package-shaka.sh', import.meta.url))
const has = (cmd) => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0

const ODD = '360:500:777:999 720:1500:2250:3001'

/** Run a script in print mode; `lines[0]` is the filter graph and the rest are its ffmpeg arguments. */
function print(script, env) {
  const r = spawnSync('bash', [script, 'demo'], { env: { PATH: process.env.PATH, PRINT_ARGS: '1', ...env }, encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr, lines: r.stdout.split('\n').filter(Boolean) }
}
const args = (p) => p.lines.slice(1).join(' ')

test('package.sh gives each rung exactly the height, rate, peak and buffer it was handed', () => {
  const p = print(FFMPEG_SCRIPT, { RUNGS: ODD })
  assert.equal(p.status, 0, p.stderr)
  assert.match(p.lines[0], /^\[0:v\]split=2\[s0\]\[s1\];\[s0\]scale=-2:360\[v0\];\[s1\]scale=-2:720\[v1\]$/)
  assert.match(args(p), /-b:v:0 500k -maxrate:v:0 777k -bufsize:v:0 999k/)
  assert.match(args(p), /-b:v:1 1500k -maxrate:v:1 2250k -bufsize:v:1 3001k/)
})

test('package.sh does not need the source to exist to print, and writes nothing', () => {
  const p = print(FFMPEG_SCRIPT, { RUNGS: ODD, INPUT: '/nonexistent.mp4', OUT: '/nonexistent/out' })
  assert.equal(p.status, 0, p.stderr)
})

test('package.sh follows the shared ladder, for the fixed table and for --quick', () => {
  for (const quick of [false, true]) {
    const rungs = selectRungs(1080, { quick })
    const p = print(FFMPEG_SCRIPT, { RUNGS: encodeSpec(rungs) })
    assert.equal(p.status, 0, p.stderr)
    rungs.forEach((r, i) => {
      assert.ok(p.lines[0].includes(`[s${i}]scale=-2:${r.height}[v${i}]`), `rung ${i} height`)
      assert.ok(args(p).includes(`-b:v:${i} ${r.kbps}k -maxrate:v:${i} ${Math.floor(r.kbps * 1.5)}k -bufsize:v:${i} ${r.kbps * 2}k`), `rung ${i} rates`)
    })
  }
})

test('package.sh refuses a missing ladder and a rung without its limits', () => {
  assert.notEqual(print(FFMPEG_SCRIPT, {}).status, 0)
  const p = print(FFMPEG_SCRIPT, { RUNGS: '360:800' })
  assert.notEqual(p.status, 0)
  assert.match(p.stderr, /expected height:kbps:maxrate:bufsize/)
})

// package-shaka.sh reads the frame rate of its input even in print mode, so it needs a real (tiny) clip.
const skip = has('ffmpeg') && has('ffprobe') ? false : 'ffmpeg/ffprobe not installed'
let dir
let clip
before(() => {
  if (skip) return
  dir = mkdtempSync(join(tmpdir(), 'packager-scripts-'))
  clip = join(dir, 'clip.mp4')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip])
})
after(() => dir && rmSync(dir, { recursive: true, force: true }))

test('package-shaka.sh gives each rung exactly the height, rate, peak and buffer it was handed', { skip }, () => {
  const p = print(SHAKA_SCRIPT, { RUNGS: ODD, INPUT: clip, OUT: join(dir, 'out') })
  assert.equal(p.status, 0, p.stderr)
  assert.match(p.lines[0], /scale=-2:360,setsar=1\[v0\];\[s1\]scale=-2:720,setsar=1\[v1\]$/)
  assert.match(args(p), /-b:v 500k -maxrate 777k -bufsize 999k/)
  assert.match(args(p), /-b:v 1500k -maxrate 2250k -bufsize 3001k/)
})

test('package-shaka.sh with a constant quality aims at the quality and still caps at the handed limits', { skip }, () => {
  const p = print(SHAKA_SCRIPT, { RUNGS: ODD, INPUT: clip, OUT: join(dir, 'out'), CRF: '21' })
  assert.equal(p.status, 0, p.stderr)
  assert.match(args(p), /-crf 21 -maxrate 777k -bufsize 999k/)
  assert.ok(!args(p).includes('-b:v '), 'no target rate when a quality is given')
})

test('package-shaka.sh prints without creating its output directory, and refuses a rung without its limits', { skip }, async () => {
  const { existsSync } = await import('node:fs')
  const out = join(dir, 'never-made')
  assert.equal(print(SHAKA_SCRIPT, { RUNGS: ODD, INPUT: clip, OUT: out }).status, 0)
  assert.equal(existsSync(out), false)
  const bad = print(SHAKA_SCRIPT, { RUNGS: '360:800', INPUT: clip, OUT: out })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /expected height:kbps:maxrate:bufsize/)
})
