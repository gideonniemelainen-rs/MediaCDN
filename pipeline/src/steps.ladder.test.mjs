import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LADDER_CRF, selectRungs } from './ladder.mjs'
import { createSteps } from './steps.mjs'

const profile = { name: 'test', limits: {}, normalise: {} }
const info = { duration: 30, video: { displayWidth: 1280, displayHeight: 720 } }
const ctx = (over = {}) => ({ meta: { uploadId: 'u1' }, shared: { info, fps: 30, mezzanine: '/m.mkv', ...over } })
const h = { progress() {}, log: (l) => h.lines.push(l), lines: [] }
const steps = (opts) => createSteps({ profile, work: '/w', origin: '/o', ...opts })

test('the ffmpeg packager gets the fixed ladder, and says why', async () => {
  const c = ctx()
  const r = await steps({ packager: 'ffmpeg', measure: async () => assert.fail('must not probe') }).ladder(c, h)
  assert.deepEqual(r.result.rungs, selectRungs(720))
  assert.equal(r.result.fixed, true)
  assert.match(r.summary, /fixed ladder \(the ffmpeg packager uses a fixed table\)/)
  assert.equal(c.shared.ladder.crf, null, 'no constant quality is passed to it')
})

test('a failed probe falls back to the fixed ladder instead of failing the upload', async () => {
  const c = ctx()
  h.lines.length = 0
  const r = await steps({ packager: 'shaka', measure: async () => { throw new Error('ffmpeg exploded') } }).ladder(c, h)
  assert.equal(r.result.fixed, true)
  assert.equal(r.result.reason, 'complexity probe failed')
  assert.ok(h.lines.some((l) => /ffmpeg exploded/.test(l)), 'the reason is in the stage log')
  assert.deepEqual(c.shared.ladder.rungs, selectRungs(720))
})

test('a measurement becomes the ladder the package stage will use', async () => {
  const c = ctx()
  const measure = async (o) => {
    assert.deepEqual(o.heights, [240, 360, 480, 720])
    assert.equal(o.crf, LADDER_CRF)
    assert.equal(o.gop, 120, '30 fps, 4 s segments')
    assert.equal(o.mezzanine, '/m.mkv')
    return { measured: [{ height: 240, kbps: 260 }, { height: 360, kbps: 538 }, { height: 480, kbps: 850 }, { height: 720, kbps: 1360 }], windows: [], seconds: 18 }
  }
  const r = await steps({ packager: 'shaka', measure }).ladder(c, h)
  assert.equal(r.result.fixed, false)
  assert.equal(r.result.class, 'film')
  assert.deepEqual(c.shared.ladder, { rungs: r.result.rungs, crf: LADDER_CRF })
  assert.equal(r.summary, '4 rungs, 260–1360 kbps · film content')
})

test('without a known frame rate the fixed ladder is used', async () => {
  const r = await steps({ packager: 'shaka', measure: async () => assert.fail('must not probe') }).ladder(ctx({ fps: undefined }), h)
  assert.equal(r.result.reason, 'frame rate unknown')
})
