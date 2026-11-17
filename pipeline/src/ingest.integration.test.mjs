// End to end: generates the synthetic fixtures, runs the real CLI on each and checks the
// mezzanine with ffprobe. Skipped when ffmpeg is missing; HDR also needs a zimg build.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const pipeline = fileURLToPath(new URL('..', import.meta.url))
const has = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0
const haveFfmpeg = has('ffmpeg', ['-version']) && has('ffprobe', ['-version'])
const haveZscale = haveFfmpeg && execFileSync('ffmpeg', ['-hide_banner', '-filters']).toString().includes(' zscale ')
const skip = haveFfmpeg ? false : 'ffmpeg/ffprobe not installed'

const tmp = mkdtempSync(join(tmpdir(), 'ingest-'))
const fx = join(tmp, 'fx')
const work = join(tmp, 'work')

before(() => {
  if (haveFfmpeg) execFileSync('bash', [join(pipeline, 'fixtures/generate.sh'), fx], { stdio: 'inherit' })
})

function ingest(file) {
  const r = spawnSync('node', [join(pipeline, 'bin/ingest.mjs'), join(fx, file), '--work', work], { encoding: 'utf8' })
  const key = /^([0-9a-f]{16}):/.exec(r.stdout)?.[1]
  const job = key ? JSON.parse(readFileSync(join(work, key, 'job.json'), 'utf8')) : null
  return { ...r, key, job }
}

function probeMezzanine(key) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', join(work, key, 'mezzanine.mkv'),
  ])
  const j = JSON.parse(out)
  return { v: j.streams.find((s) => s.codec_type === 'video'), a: j.streams.filter((s) => s.codec_type === 'audio'), format: j.format }
}

function assertUniform({ v, a }) {
  assert.equal(v.pix_fmt, 'yuv420p')
  assert.equal(v.width % 2, 0)
  assert.equal(v.height % 2, 0)
  assert.ok(['1:1', 'N/A', undefined].includes(v.sample_aspect_ratio), `sar ${v.sample_aspect_ratio}`)
  assert.equal(v.r_frame_rate, v.avg_frame_rate, 'constant frame rate')
  assert.equal(a.length, 1, 'exactly one audio track')
  assert.equal(a[0].channels, 2)
  assert.equal(a[0].sample_rate, '48000')
}

const fps = (v) => Number(v.r_frame_rate.split('/')[0]) / Number(v.r_frame_rate.split('/')[1])

test('clean input passes through unchanged in shape', { skip }, () => {
  const r = ingest('clean.mp4')
  assert.equal(r.status, 0, r.stderr)
  const m = probeMezzanine(r.key)
  assertUniform(m)
  assert.deepEqual([m.v.width, m.v.height, fps(m.v)], [640, 360, 30])
})

test('silent screen recording gets synthesised audio and a clean low frame rate', { skip }, () => {
  const r = ingest('screen-silent.mp4')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.job.normalise.audio, { synthesised: true })
  const m = probeMezzanine(r.key)
  assertUniform(m)
  assert.equal(fps(m.v), 10)
  assert.ok(Math.abs(Number(m.format.duration) - 2) < 0.2, `duration ${m.format.duration}`)
})

test('rotated phone clip comes out upright', { skip }, () => {
  const r = ingest('phone-rotated.mp4')
  assert.equal(r.status, 0, r.stderr)
  const m = probeMezzanine(r.key)
  assertUniform(m)
  assert.deepEqual([m.v.width, m.v.height], [640, 360])
})

test('VFR clip becomes CFR at a standard rate', { skip }, () => {
  const r = ingest('vfr.mp4')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.job.warnings.some((w) => w.code === 'W_VFR'))
  const m = probeMezzanine(r.key)
  assertUniform(m)
  assert.ok([10, 15, 24, 25, 30].includes(fps(m.v)), `fps ${fps(m.v)}`)
})

test('multi-audio clip keeps one stereo track', { skip }, () => {
  const r = ingest('multi-audio.mp4')
  assert.equal(r.status, 0, r.stderr)
  assertUniform(probeMezzanine(r.key))
})

test('HDR10 clip is tonemapped to SDR BT.709', { skip: skip || (!haveZscale && 'ffmpeg lacks zscale') }, (t) => {
  if (!existsSync(join(fx, 'hdr10.mp4'))) return t.skip('hdr10 fixture not generated')
  const r = ingest('hdr10.mp4')
  assert.equal(r.status, 0, r.stderr)
  const m = probeMezzanine(r.key)
  assertUniform(m)
  assert.equal(m.v.color_transfer, 'bt709')
})

test('audio-only and truncated inputs are rejected with exit 2', { skip }, () => {
  const audioOnly = ingest('audio-only.m4a')
  assert.equal(audioOnly.status, 2)
  assert.match(audioOnly.stderr, /E_AUDIO_ONLY/)

  const cut = spawnSync('node', [join(pipeline, 'bin/ingest.mjs'), join(fx, 'truncated.mp4'), '--work', work], { encoding: 'utf8' })
  assert.equal(cut.status, 2)
  assert.match(cut.stderr, /E_UNREADABLE/)
})

test('re-ingesting the same file is a no-op', { skip }, () => {
  const again = spawnSync('node', [join(pipeline, 'bin/ingest.mjs'), join(fx, 'clean.mp4'), '--work', work], { encoding: 'utf8' })
  assert.equal(again.status, 0)
  assert.match(again.stdout, /already normalised/)
})
