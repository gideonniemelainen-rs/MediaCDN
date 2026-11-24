// End to end through the Shaka Packager path: real stages, a real server, and the real worker image run
// with docker. Skipped when ffmpeg, docker or the image (docker build -t mediacdn-pipeline:dev pipeline/) is missing.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseMediaPlaylist } from '../../tools/live.mjs'
import { LADDER_CRF } from './ladder.mjs'
import { DEFAULT_IMAGE } from './packagers.mjs'
import { createPipelineServer } from './server.mjs'
import { createSteps } from './steps.mjs'

const pipeline = fileURLToPath(new URL('..', import.meta.url))
const ok = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0
const skip =
  !ok('ffmpeg', ['-version']) || !ok('ffprobe', ['-version']) ? 'ffmpeg/ffprobe not installed'
    : !ok('docker', ['image', 'inspect', DEFAULT_IMAGE]) ? `docker or the ${DEFAULT_IMAGE} image is missing`
    : false

let root, fx, profile
const servers = []

before(async () => {
  if (skip) return
  root = await mkdtemp(join(tmpdir(), 'pipeline-shaka-'))
  fx = join(root, 'fx')
  execFileSync('bash', [join(pipeline, 'fixtures/generate.sh'), fx], { stdio: 'inherit' })
  // 14 s at 30 fps: four 4 s segments (the last short), so keyframe alignment has something to prove.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=14', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=14', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(fx, 'long.mp4')])
  profile = JSON.parse(await readFile(join(pipeline, 'profiles/default.json'), 'utf8'))
})

after(async () => {
  if (skip) return
  for (const s of servers) {
    s.server.close()
    s.server.closeAllConnections()
  }
  await rm(root, { recursive: true, force: true })
})

async function start(name, options = {}) {
  const origin = join(root, `${name}-origin`)
  const work = join(root, `${name}-work`)
  const { server, manager } = await createPipelineServer({ work, origin, profile, steps: createSteps({ profile, work, origin, packager: 'shaka', ...options }) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  servers.push({ server })
  const base = `http://127.0.0.1:${server.address().port}/api/pipeline`
  const run = async (file) => {
    const res = await fetch(`${base}/uploads`, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(file) }, body: await readFile(join(fx, file)) })
    assert.equal(res.status, 202)
    const { id } = await res.json()
    await manager.idle()
    return (await fetch(`${base}/jobs/${id}`)).json()
  }
  return { origin, run }
}

const stage = (job, id) => job.stages.find((s) => s.id === id)
const states = (job) => job.stages.map((s) => s.status)
const failedChecks = (job) => stage(job, 'verify').result.checks.filter((c) => !c.ok)

test('a long clip is packaged with Shaka Packager and passes every verify check', { skip }, async () => {
  const t = await start('long')
  const job = await t.run('long.mp4')
  assert.equal(job.status, 'success', JSON.stringify(states(job)))
  assert.equal(stage(job, 'package').result.packager, 'shaka')
  assert.match(stage(job, 'package').summary, /Shaka Packager/)
  assert.deepEqual(failedChecks(job), [])
  // 720p source: every rung of the ladder.
  assert.deepEqual(stage(job, 'package').result.rungs.map((r) => r.height), [240, 360, 480, 720])

  const dir = join(t.origin, 'ugc-long')
  const files = await readdir(dir)
  assert.ok(!files.some((f) => f.startsWith('.')), `leftovers: ${files.filter((f) => f.startsWith('.'))}`)
  assert.deepEqual((await readdir(t.origin)).filter((n) => n.startsWith('.tmp-')), [])

  const master = await readFile(join(dir, 'master.m3u8'), 'utf8')
  assert.equal((master.match(/AVERAGE-BANDWIDTH=/g) ?? []).length, 4, 'one per video rendition')
  assert.match(master, /FRAME-RATE=30\.000/)
  assert.match(master, /VIDEO-RANGE=SDR/)
  assert.match(master, /TYPE=AUDIO.*DEFAULT=YES/)
  assert.match(await readFile(join(dir, 'manifest.mpd'), 'utf8'), /type="static"/)
})

test('segments are 4 s and every one starts on a keyframe', { skip }, async () => {
  const dir = join(root, 'long-origin', 'ugc-long')
  for (const rung of [0, 3]) {
    const playlist = parseMediaPlaylist(await readFile(join(dir, `media_${rung}.m3u8`), 'utf8'))
    const durations = playlist.segments.map((s) => s.duration)
    assert.equal(durations.length, 4, durations.join())
    for (const d of durations.slice(0, -1)) assert.ok(Math.abs(d - 4) < 0.05, `${d}`)
    assert.ok(Math.abs(durations.at(-1) - 2) < 0.1, `last ${durations.at(-1)}`)
    for (const seg of playlist.segments) {
      const probe = join(root, `probe-${rung}.mp4`)
      await writeFile(probe, Buffer.concat([await readFile(join(dir, playlist.init)), await readFile(join(dir, seg.uri))]))
      const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=flags', '-of', 'csv=p=0', '-read_intervals', '%+#1', probe]).toString()
      assert.match(out.trim().split('\n')[0], /K/, `${seg.uri} does not start on a keyframe`)
    }
  }
})

test('every rung has the right size and square pixels, tagged BT.709', { skip }, async () => {
  const dir = join(root, 'long-origin', 'ugc-long')
  for (const [i, h] of [240, 360, 480, 720].entries()) {
    const playlist = parseMediaPlaylist(await readFile(join(dir, `media_${i}.m3u8`), 'utf8'))
    const probe = join(root, `size-${i}.mp4`)
    await writeFile(probe, Buffer.concat([await readFile(join(dir, playlist.init)), await readFile(join(dir, playlist.segments[0].uri))]))
    const [height, sar, trc, primaries, matrix] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height,sample_aspect_ratio,color_transfer,color_primaries,color_space', '-of', 'csv=p=0', probe]).toString().trim().split(',')
    assert.equal(Number(height), h, `rung ${i}`)
    assert.ok(sar === '1:1' || sar === 'N/A', `rung ${i} sar ${sar}`) // N/A means unset, which is square
    assert.deepEqual([trc, primaries, matrix], ['bt709', 'bt709', 'bt709'], `rung ${i} colour`)
  }
  const master = await readFile(join(dir, 'master.m3u8'), 'utf8')
  assert.deepEqual([...master.matchAll(/RESOLUTION=(\d+x\d+)/g)].map((m) => m[1]), ['426x240', '640x360', '854x480', '1280x720'])
})

test('a short 360p clip and a silent screen recording package too', { skip }, async () => {
  const t = await start('short')
  const clean = await t.run('clean.mp4')
  assert.equal(clean.status, 'success', JSON.stringify(states(clean)))
  assert.deepEqual(failedChecks(clean), [])
  assert.deepEqual(stage(clean, 'package').result.rungs.map((r) => r.height), [240, 360])

  const silent = await t.run('screen-silent.mp4')
  assert.equal(silent.status, 'success', JSON.stringify(states(silent)))
  assert.deepEqual(failedChecks(silent), [])
  assert.match(await readFile(join(t.origin, 'ugc-screen-silent', 'master.m3u8'), 'utf8'), /TYPE=AUDIO/)
})

test('the ladder stage measures the title and the packaged rungs are exactly what it chose', { skip }, async () => {
  const t = await start('ladder')
  const busy = await t.run('long.mp4')
  const l = stage(busy, 'ladder')
  assert.equal(l.status, 'success')
  assert.equal(l.result.fixed, false)
  assert.equal(l.result.crf, LADDER_CRF)
  assert.deepEqual(stage(busy, 'package').result.rungs, l.result.rungs, 'package encodes the ladder, not the fixed table')
  assert.deepEqual(l.result.measured.map((m) => m.height), [240, 360, 480, 720])
  assert.match(l.summary, /rungs, \d+–\d+ kbps · (film|screen) content/)
  // Capped CRF: no rendition's peak may exceed its VBV cap (1.5x the rung rate) by more than muxing overhead.
  const peaks = stage(busy, 'verify').result.renditions.map((r) => r.bandwidth)
  l.result.rungs.forEach((r, i) => assert.ok(peaks[i] <= r.kbps * 1000 * 1.5 * 1.3, `rung ${r.height}p peaks at ${peaks[i]} against a cap of ${r.kbps * 1500}`))

  // A flat, silent screen recording is far cheaper than the fixed ladder and loses 240p.
  const flat = await t.run('screen-silent.mp4')
  const lf = stage(flat, 'ladder')
  assert.equal(lf.result.class, 'screen')
  assert.ok(!lf.result.rungs.some((r) => r.height < 360))
  assert.ok(lf.result.rungs.at(-1).kbps < 800, `${lf.result.rungs.at(-1).kbps} kbps for 360p, the fixed table says 800`)
  assert.deepEqual(stage(flat, 'package').result.rungs, lf.result.rungs)
})

test('uploading the same file again reuses the mezzanine and republishes', { skip }, async () => {
  const t = await start('again')
  await t.run('clean.mp4')
  const job = await t.run('clean.mp4')
  assert.equal(job.status, 'success')
  assert.equal(stage(job, 'normalise').status, 'cached')
  assert.equal(stage(job, 'package').result.packager, 'shaka')
})

test('a missing worker image fails the package stage with a readable reason and publishes nothing', { skip }, async () => {
  const t = await start('noimage', { image: 'mediacdn-pipeline-does-not-exist:none' })
  const job = await t.run('clean.mp4')
  assert.equal(job.status, 'failed')
  assert.equal(stage(job, 'package').status, 'failed')
  assert.equal(stage(job, 'package').result.code, 'E_PACKAGE_FAILED')
  assert.deepEqual(states(job).slice(6), ['skipped', 'skipped'])
  const left = await readdir(t.origin).catch(() => [])
  assert.deepEqual(left, [], 'nothing staged or published')
})
