import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LADDER_CRF, SCREEN_BPP, bitsPerPixel, candidateHeights, planLadder } from './ladder.mjs'

const heights = (plan) => plan.rungs.map((r) => r.height)
const kbps = (plan) => plan.rungs.map((r) => r.kbps)

// What a constant-quality probe measured on real clips: 720p film (bbb), and a 1920x1020 screen recording.
const FILM = [{ height: 240, kbps: 260 }, { height: 360, kbps: 538 }, { height: 480, kbps: 850 }, { height: 720, kbps: 1360 }]
const SCREEN = [{ height: 240, kbps: 30 }, { height: 360, kbps: 63 }, { height: 480, kbps: 110 }, { height: 720, kbps: 170 }]

test('film keeps the whole ladder at the rates it measured', () => {
  const plan = planLadder(FILM, { aspect: 16 / 9, fps: 24 })
  assert.equal(plan.class, 'film')
  assert.deepEqual(heights(plan), [240, 360, 480, 720])
  assert.deepEqual(kbps(plan), [260, 540, 850, 1360])
  assert.deepEqual(plan.dropped, [])
})

test('a screen recording costs a fraction of the fixed ladder and loses the unreadable 240p', () => {
  const plan = planLadder(SCREEN, { aspect: 1920 / 1020, fps: 30 })
  assert.equal(plan.class, 'screen')
  assert.deepEqual(heights(plan), [360, 480, 720])
  assert.ok(plan.rungs.at(-1).kbps <= 300, `720p at ${plan.rungs.at(-1).kbps} kbps, against 2800 in the fixed table`)
  assert.equal(plan.dropped[0].height, 240)
})

test('film at 240p is kept: only screen content drops it', () => {
  assert.ok(heights(planLadder(FILM, { aspect: 16 / 9, fps: 24 })).includes(240))
})

test('a rung barely cheaper than the one above is dropped, but the 360p-or-lower rung never is', () => {
  const flat = [{ height: 360, kbps: 500 }, { height: 480, kbps: 520 }, { height: 720, kbps: 560 }]
  const plan = planLadder(flat, { aspect: 16 / 9, fps: 24 })
  assert.deepEqual(heights(plan), [360, 720], '480p costs the same as 720p, so 720p wins; 360p stays for unfocused quadrants')
  assert.match(plan.dropped[0].reason, /720p costs about the same/)
})

test('rates stay inside the bounds for their height, and never fall below the rung under them', () => {
  const wild = [{ height: 360, kbps: 20 }, { height: 720, kbps: 9000 }]
  assert.deepEqual(kbps(planLadder(wild, { aspect: 16 / 9, fps: 30 })), [120, 4200])
  const inverted = [{ height: 360, kbps: 900 }, { height: 720, kbps: 400 }]
  const plan = planLadder(inverted, { aspect: 16 / 9, fps: 30 })
  assert.ok(plan.rungs.every((r, i, all) => i === 0 || r.kbps >= all[i - 1].kbps))
})

test('a source smaller than every table rung gets one rung', () => {
  const plan = planLadder([{ height: 200, kbps: 700 }], { aspect: 16 / 9, fps: 30 })
  assert.deepEqual(plan.rungs, [{ height: 200, kbps: 700 }])
})

test('every plan has a rung at or below 360p and rungs rise with height', () => {
  for (const source of [240, 360, 480, 720, 1080]) {
    for (const scale of [0.05, 1, 6]) {
      const measured = candidateHeights(source).map((h) => ({ height: h, kbps: Math.round(h * scale * 2) }))
      const plan = planLadder(measured, { aspect: 16 / 9, fps: 30 })
      assert.ok(plan.rungs.some((r) => r.height <= 360), `${source} x${scale}`)
      assert.ok(plan.rungs.every((r, i, all) => i === 0 || (r.height > all[i - 1].height && r.kbps >= all[i - 1].kbps)), `${source} x${scale}`)
    }
  }
})

test('complexity is bits per pixel per frame, and the screen threshold separates the measured clips', () => {
  assert.ok(Math.abs(bitsPerPixel({ height: 720, kbps: 1360, aspect: 16 / 9, fps: 24 }) - 0.0615) < 0.001)
  assert.ok(bitsPerPixel({ height: 720, kbps: 170, aspect: 1920 / 1020, fps: 30 }) < SCREEN_BPP)
  assert.ok(bitsPerPixel({ height: 720, kbps: 467, aspect: 1920 / 1020, fps: 50 }) < SCREEN_BPP, 'the busier 50 fps screen recording is still screen')
  assert.ok(bitsPerPixel({ height: 720, kbps: 1360, aspect: 16 / 9, fps: 24 }) > SCREEN_BPP)
})

test('candidates are the table rungs the source can fill', () => {
  assert.deepEqual(candidateHeights(720), [240, 360, 480, 720])
  assert.deepEqual(candidateHeights(200), [200])
})

test('nothing measured is an error, and the probe quality is a constant', () => {
  assert.throws(() => planLadder([], { aspect: 16 / 9, fps: 30 }), /at least one/)
  assert.equal(LADDER_CRF, 21)
})
