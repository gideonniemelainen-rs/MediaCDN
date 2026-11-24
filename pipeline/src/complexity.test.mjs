import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { averageKbps, gopFrames, measureComplexity, sampleWindows, windowArgs } from './complexity.mjs'

test('a short clip is sampled whole, a long one in three windows spread across it', () => {
  assert.deepEqual(sampleWindows(4), [{ start: 0, length: 4 }])
  assert.deepEqual(sampleWindows(18), [{ start: 0, length: 18 }])
  const w = sampleWindows(600)
  assert.equal(w.length, 3)
  assert.deepEqual(w.map((x) => x.length), [6, 6, 6])
  assert.deepEqual(w.map((x) => Math.round(x.start)), [97, 297, 497])
  assert.deepEqual(sampleWindows(0), [])
})

test('windows never run past the end', () => {
  for (const d of [18.5, 19, 25, 61]) for (const x of sampleWindows(d)) assert.ok(x.start >= 0 && x.start + x.length <= d + 1e-9, `${d}`)
})

test('one ffmpeg pass per window decodes once and encodes every height at constant quality', () => {
  const a = windowArgs({ input: '/m.mkv', window: { start: 12.5, length: 6 }, heights: [360, 720], crf: 23, dir: '/t' })
  const graph = a[a.indexOf('-filter_complex') + 1]
  assert.equal(graph, '[0:v]split=2[s0][s1];[s0]scale=-2:360,setsar=1[v0];[s1]scale=-2:720,setsar=1[v1]')
  assert.equal(a.filter((x) => x === '-crf').length, 2)
  assert.ok(a.includes('/t/h360.mp4') && a.includes('/t/h720.mp4'))
  assert.equal(a[a.indexOf('-ss') + 1], '12.500')
  assert.equal(a.filter((x) => x === '-i').length, 1)
})

test('the probe can use the keyframe spacing of the real encode, and keeps the ffmpeg default without one', () => {
  assert.equal(gopFrames(24), 96)
  assert.equal(gopFrames(29.97), 120)
  const base = { input: '/m.mkv', window: { start: 0, length: 6 }, heights: [360], crf: 21, dir: '/t' }
  const withGop = windowArgs({ ...base, gop: 96 })
  for (const flag of ['-g', '-keyint_min']) assert.equal(withGop[withGop.indexOf(flag) + 1], '96')
  assert.equal(withGop[withGop.indexOf('-sc_threshold') + 1], '0')
  assert.ok(!windowArgs(base).includes('-g'))
})

test('average bitrate is weighted by window length', () => {
  const r = averageKbps([{ length: 6, bytes: { 360: 75_000 } }, { length: 2, bytes: { 360: 25_000 } }], [360])
  assert.deepEqual(r, [{ height: 360, kbps: 100 }])
})

const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
test('noisy video measures far more expensive than flat video at the same height', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'complexity-'))
  try {
    const make = (name, src) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, name)])
    assert.equal(make('flat.mp4', 'color=c=white:s=1280x720:r=30:d=4,drawbox=x=40:y=40:w=300:h=20:color=black:t=fill').status, 0)
    assert.equal(make('noisy.mp4', 'testsrc2=s=1280x720:r=30:d=4,noise=alls=40:allf=t').status, 0)
    const at = (name) => measureComplexity({ mezzanine: join(root, name), duration: 4, heights: [360, 720], crf: 23, tmp: join(root, `t-${name}`) })
    const flat = await at('flat.mp4')
    const noisy = await at('noisy.mp4')
    const k = (r, h) => r.measured.find((m) => m.height === h).kbps
    assert.ok(k(noisy, 720) > 20 * Math.max(1, k(flat, 720)), `noisy ${k(noisy, 720)} vs flat ${k(flat, 720)} kbps`)
    assert.ok(k(noisy, 720) > k(noisy, 360), 'a taller picture costs more')
    assert.equal(noisy.seconds, 4)
    assert.deepEqual((await readdir(root)).filter((n) => n.startsWith('t-')), [], 'the scratch directory is removed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failing ffmpeg rejects with its message and still cleans up', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'complexity-'))
  try {
    await assert.rejects(measureComplexity({ mezzanine: join(root, 'missing.mkv'), duration: 4, heights: [360], crf: 23, tmp: join(root, 't') }), /missing\.mkv|No such file/)
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
