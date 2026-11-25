import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LADDER_CRF, selectRungs } from '../../shared/src/ladder.ts'
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

const planMeasure = async () => ({ measured: [{ height: 240, kbps: 260 }, { height: 360, kbps: 538 }, { height: 480, kbps: 850 }, { height: 720, kbps: 1360 }], windows: [], seconds: 1 })

test('a packager chosen in the settings applies to the next job, with no restart', async () => {
  let stored = {}
  const s = steps({ packager: 'ffmpeg', measure: planMeasure, getPackaging: async () => stored })
  assert.equal((await s.ladder(ctx(), h)).result.fixed, true, 'no override: the env default (ffmpeg)')
  stored = { packager: 'shaka' }
  assert.equal((await s.ladder(ctx(), h)).result.fixed, false, 'the next job measures, as the shaka path does')
  stored = {}
  assert.equal((await s.ladder(ctx(), h)).result.fixed, true, 'an override removed puts the default back')
})

test('a job reads the packaging settings once, so its stages agree', async () => {
  let stored = { packager: 'shaka' }
  let reads = 0
  const s = steps({ measure: planMeasure, getPackaging: async () => (reads++, stored) })
  const c = ctx()
  await s.ladder(c, h)
  stored = { packager: 'ffmpeg' } // changed mid-job
  await s.ladder(c, h)
  assert.equal(reads, 1)
  assert.equal(c.shared.packaging.packager, 'shaka')
})

test('the stored quality and image reach the job; the rest stay the defaults', async () => {
  const c = ctx()
  let crf
  await steps({ packager: 'shaka', measure: async (o) => ((crf = o.crf), planMeasure()), getPackaging: async () => ({ ladderCrf: 25, image: 'x/y:1' }) }).ladder(c, h)
  assert.equal(crf, 25)
  assert.deepEqual(c.shared.packaging, { packager: 'shaka', image: 'x/y:1', ladderCrf: 25 })
  assert.equal(c.shared.ladder.crf, 25)
})

test('unusable stored values are ignored, and an unreachable store means the defaults', async () => {
  const c = ctx()
  await steps({ packager: 'ffmpeg', getPackaging: async () => ({ packager: 'nope', ladderCrf: 3 }) }).ladder(c, h)
  assert.equal(c.shared.packaging.packager, 'ffmpeg')
  assert.equal(c.shared.packaging.ladderCrf, LADDER_CRF)

  const d = ctx()
  h.lines.length = 0
  await steps({ packager: 'ffmpeg', getPackaging: async () => { throw new Error('db down') } }).ladder(d, h)
  assert.equal(d.shared.packaging.packager, 'ffmpeg')
  assert.ok(h.lines.some((l) => /db down/.test(l)))
})
