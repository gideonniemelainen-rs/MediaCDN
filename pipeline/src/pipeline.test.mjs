import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { samples } from './ffprobe-samples.mjs'
import { jobKey, slugify } from './job.mjs'
import { planNormalise, targetFps } from './normalise.mjs'
import { parseRate, summarise } from './probe.mjs'
import { validate } from './validate.mjs'

const profile = JSON.parse(readFileSync(new URL('../profiles/default.json', import.meta.url), 'utf8'))
const info = (name) => summarise(samples[name]())
const check = (name) => validate(info(name), profile.limits)
const codes = (list) => list.map((x) => x.code)
const vf = (name) => {
  const { args } = planNormalise(info(name), profile, { input: 'in.mp4', output: 'out.mkv' })
  return args[args.indexOf('-vf') + 1]
}

test('parseRate handles rationals and junk', () => {
  assert.equal(parseRate('30000/1001').toFixed(3), '29.970')
  assert.equal(parseRate('0/0'), 0)
  assert.equal(parseRate(undefined), 0)
})

test('summarise: rotation from display matrix and legacy tag, display size swaps', () => {
  // A display matrix of -90 normalises to 270; the legacy tag says 90. Both swap the axes.
  assert.equal(info('phoneRotated').video.rotation, 270)
  assert.equal(info('legacyRotateTag').video.rotation, 90)
  for (const name of ['phoneRotated', 'legacyRotateTag']) {
    const v = info(name).video
    assert.deepEqual([v.displayWidth, v.displayHeight], [1920, 1080])
  }
})

test('summarise: HDR, bit depth, VFR, interlace, cover art', () => {
  assert.equal(info('hdr').video.hdr, true)
  assert.equal(info('hdr').video.bitDepth, 10)
  assert.equal(info('tenBitSdr').video.bitDepth, 10)
  assert.equal(info('tenBitSdr').video.hdr, false)
  assert.equal(info('screenVfr').video.vfr, true)
  assert.equal(info('clean').video.vfr, false)
  assert.equal(info('interlaced').video.interlaced, true)
  const art = info('coverArtOnly')
  assert.equal(art.video, null)
  assert.equal(art.attachedPics, 1)
})

test('validate accepts clean input without warnings', () => {
  const v = check('clean')
  assert.equal(v.ok, true)
  assert.deepEqual(v.warnings, [])
})

test('validate rejects with stable codes', () => {
  const cases = {
    noStreams: 'E_NO_VIDEO',
    audioOnly: 'E_AUDIO_ONLY',
    coverArtOnly: 'E_AUDIO_ONLY',
    tooLong: 'E_TOO_LONG',
    tooBig: 'E_FILE_TOO_LARGE',
    tooWide: 'E_RESOLUTION',
    tiny: 'E_BAD_DIMENSIONS',
    badCodec: 'E_CODEC',
    noDuration: 'E_BAD_DURATION',
  }
  for (const [name, code] of Object.entries(cases)) {
    const v = check(name)
    assert.equal(v.ok, false, name)
    assert.ok(codes(v.errors).includes(code), `${name} -> ${code}, got ${codes(v.errors)}`)
  }
})

test('validate: portrait 4K-class input is judged on display size, not rotation', () => {
  // 2160x3840 portrait is within limits even though width < height.
  const i = info('clean')
  i.video = { ...i.video, displayWidth: 2160, displayHeight: 3840 }
  assert.equal(validate(i, profile.limits).ok, true)
})

test('validate warns about what normalise will fix', () => {
  const warned = {
    screenSilent: ['W_LOW_FPS', 'W_NO_AUDIO'],
    screenVfr: ['W_VFR', 'W_LOW_FPS', 'W_NO_AUDIO'],
    phoneRotated: ['W_ROTATED'],
    hdr: ['W_HDR'],
    tenBitSdr: ['W_HIGH_BIT_DEPTH'],
    anamorphic: ['W_NON_SQUARE_SAR'],
    interlaced: ['W_INTERLACED'],
    oddDimensions: ['W_ODD_DIMENSIONS'],
    multiAudio: ['W_MULTI_AUDIO'],
    ultrawide: ['W_EXTREME_ASPECT'],
  }
  for (const [name, expected] of Object.entries(warned)) {
    const v = check(name)
    assert.equal(v.ok, true, name)
    assert.deepEqual(codes(v.warnings).sort(), expected.sort(), name)
  }
})

test('targetFps snaps to standard rates within the profile range', () => {
  const n = profile.normalise
  assert.equal(targetFps(29.97, n), 30)
  assert.equal(targetFps(23.976, n), 24)
  assert.equal(targetFps(4, n), 10)
  assert.equal(targetFps(240, n), 60)
  assert.equal(targetFps(0, n), 30)
  assert.equal(targetFps(12, n), 10)
})

test('planNormalise: filter chain per case', () => {
  assert.match(vf('clean'), /^fps=30,scale=trunc\(iw\/2\)\*2:trunc\(ih\/2\)\*2,setsar=1,format=yuv420p$/)
  assert.match(vf('anamorphic'), /scale=trunc\(iw\*sar\/2\)\*2/)
  assert.match(vf('interlaced'), /^bwdif=mode=send_frame,fps=/)
  assert.match(vf('hdr'), /tonemap=hable/)
  assert.doesNotMatch(vf('tenBitSdr'), /tonemap/)
  assert.match(vf('screenSilent'), /^fps=10,/)
  assert.match(vf('screenVfr'), /^fps=10,/)
})

test('planNormalise: silent input gets synthesised audio and -shortest', () => {
  const { args, decisions } = planNormalise(info('screenSilent'), profile, { input: 'in.mp4', output: 'out.mkv' })
  assert.deepEqual(decisions.audio, { synthesised: true })
  assert.ok(args.some((a) => a.startsWith('anullsrc=')))
  assert.equal(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1], '1:a:0')
  assert.ok(args.includes('-shortest'))
})

test('planNormalise: audio track choice prefers the default disposition', () => {
  const { args, decisions } = planNormalise(info('multiAudioSecondDefault'), profile, { input: 'in.mp4', output: 'out.mkv' })
  assert.deepEqual(decisions.audio, { track: 1, tracks: 2 })
  assert.ok(args.includes('0:a:1'))
  assert.ok(!args.includes('-shortest'))
})

test('planNormalise: strips metadata and tags output as BT.709 SDR', () => {
  const { args } = planNormalise(info('clean'), profile, { input: 'in.mp4', output: 'out.mkv' })
  const at = (flag) => args[args.indexOf(flag) + 1]
  assert.equal(at('-map_metadata'), '-1')
  assert.equal(at('-colorspace'), 'bt709')
  assert.equal(at('-pix_fmt'), 'yuv420p')
  assert.match(at('-af'), /^aformat=channel_layouts=stereo,loudnorm=.*,aresample=48000,aformat=sample_fmts=s16,asetnsamples=/)
})

test('jobKey is stable per source+profile and changes with either', () => {
  assert.equal(jobKey('abc', profile), jobKey('abc', profile))
  assert.notEqual(jobKey('abc', profile), jobKey('abd', profile))
  assert.notEqual(jobKey('abc', profile), jobKey('abc', { ...profile, version: 2 }))
})

test('slugify matches catalog ids', () => {
  assert.equal(slugify('My Screen Recording (final).MOV'), 'my-screen-recording-final')
  assert.equal(slugify('***.mp4'), 'asset')
})
