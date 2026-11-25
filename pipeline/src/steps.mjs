// The stage implementations the upload server runs (the `upload` stage is completed by the
// server itself as the file arrives). Each step gets `ctx` = { meta, shared } and the runner's
// progress/log helpers, and returns { status?, summary, result } or throws a coded error.
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { IngestError, isProgressNoise, jobPaths, normaliseFile, parseProgressLine, probeFile, readJob, writeJob } from './ingest.mjs'
import { PIPELINE_VERSION, jobKey } from './job.mjs'
import { gopFrames, measureComplexity } from './complexity.mjs'
import { LADDER_CRF, candidateHeights, planLadder, selectRungs } from '../../shared/src/ladder.ts'
import { chooseOutputId, verifyPackage } from './package.mjs'
import { explainPackagerFailure, packageCommand, packagerKind } from './packagers.mjs'
import { StageError } from './run.mjs'
import { validate } from './validate.mjs'

const PACKAGE_SCRIPT = fileURLToPath(new URL('../../scripts/package.sh', import.meta.url))
const SCRIPTS_DIR = fileURLToPath(new URL('../scripts', import.meta.url))
const exists = (p) => stat(p).then(() => true, () => false)

async function dirBytes(dir) {
  let total = 0
  for (const f of await readdir(dir)) total += (await stat(join(dir, f))).size
  return total
}

const mb = (n) => `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`

/** Directories already in origin/, mapped to the source sha an upload recorded in them (or null). */
export async function readOriginOwners(origin) {
  const owners = new Map()
  let entries = []
  try {
    entries = await readdir(origin, { withFileTypes: true })
  } catch {}
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const rec = await readFile(join(origin, e.name, 'source.json'), 'utf8').then(JSON.parse, () => null)
    owners.set(e.name, rec?.sha256 ?? null)
  }
  return owners
}

export const outputIdFor = async (origin, slug, sha) => chooseOutputId(slug, sha, await readOriginOwners(origin))

/**
 * `packager` is 'ffmpeg' (scripts/package.sh on the host, the default) or 'shaka' (Shaka Packager in the
 * worker `image`, run with docker); it defaults to PIPELINE_PACKAGER. `measure` is the complexity probe, injectable for tests.
 */
export function createSteps({ profile, work, origin, packageScript = PACKAGE_SCRIPT, packager = process.env.PIPELINE_PACKAGER, image = process.env.PIPELINE_IMAGE, measure = measureComplexity }) {
  const kind = packagerKind(packager)
  const staging = (ctx) => join(origin, `.tmp-${ctx.meta.uploadId}`)

  return {
    async probe(ctx) {
      const info = await probeFile(ctx.meta.source)
      ctx.shared.info = info
      const v = info.video
      const text = v
        ? `${v.displayWidth}x${v.displayHeight} ${v.codec}, ${(v.vfr ? v.avgFps : v.rFps).toFixed(1)} fps${v.vfr ? ' (variable)' : ''}, ${info.duration.toFixed(1)} s, ${info.audio.length ? `${info.audio.length} audio` : 'no audio'}`
        : 'no video stream'
      return { summary: text, result: { info } }
    },

    async validate(ctx) {
      const verdict = validate(ctx.shared.info, profile.limits)
      ctx.shared.verdict = verdict
      const result = { facts: verdict.facts, warnings: verdict.warnings, errors: verdict.errors }
      if (!verdict.ok) {
        const e = verdict.errors[0]
        throw new StageError(e.code, `${e.message}${e.detail ? ` (${e.detail})` : ''}`, { result })
      }
      const n = verdict.warnings.length
      return { summary: n ? `accepted with ${n} warning${n > 1 ? 's' : ''}` : 'accepted', result }
    },

    async normalise(ctx, h) {
      const { info, verdict } = ctx.shared
      const key = jobKey(ctx.meta.sha256, profile)
      const { dir, jobFile, mezzanine } = jobPaths(work, key)
      await mkdir(dir, { recursive: true })
      ctx.shared.mezzanine = mezzanine

      const prior = await readJob(jobFile)
      if (prior?.status === 'normalised' && (await exists(mezzanine))) {
        ctx.shared.fps = prior.normalise?.fps
        const bytes = (await stat(mezzanine)).size
        return { status: 'cached', summary: `already normalised (${key}), ${mb(bytes)}`, result: { key, decisions: prior.normalise, mezzanineBytes: bytes } }
      }

      const record = { jobKey: key, id: ctx.meta.outputId, pipelineVersion: PIPELINE_VERSION, profile: profile.name, source: { file: ctx.meta.name, sha256: ctx.meta.sha256, bytes: info.bytes, info } }
      const tmp = `${mezzanine}.part`
      let plan
      try {
        plan = await normaliseFile({ file: ctx.meta.source, info, profile, output: tmp, onProgress: h.progress })
        await rename(tmp, mezzanine)
      } catch (e) {
        await rm(tmp, { force: true })
        const detail = e instanceof IngestError ? e.detail : e.message
        await writeJob(jobFile, { ...record, status: 'failed', errors: [{ code: 'E_DECODE_FAILED', detail }], warnings: verdict.warnings })
        throw new StageError('E_DECODE_FAILED', detail)
      }
      await writeJob(jobFile, { ...record, status: 'normalised', errors: [], warnings: verdict.warnings, normalise: plan.decisions, mezzanine: 'mezzanine.mkv' })
      const bytes = (await stat(mezzanine)).size
      const d = plan.decisions
      ctx.shared.fps = d.fps
      const bits = [`${d.fps} fps constant`, d.audio.synthesised ? 'silent audio added' : 'audio kept']
      if (d.tonemapped) bits.push('HDR tonemapped')
      if (d.rotated) bits.push(`rotated ${d.rotated}°`)
      return { summary: `${bits.join(', ')}, ${mb(bytes)}`, result: { key, decisions: d, mezzanineBytes: bytes } }
    },

    async ladder(ctx, h) {
      const { info } = ctx.shared
      // Even, because the mezzanine's dimensions are (normalise rounds them down).
      const sourceHeight = Math.floor(info.video.displayHeight / 2) * 2
      const fixed = selectRungs(sourceHeight)
      const fallback = (why) => {
        ctx.shared.ladder = { rungs: fixed, crf: null }
        return { summary: `${fixed.map((r) => `${r.height}p`).join(', ')} · fixed ladder${why ? ` (${why})` : ''}`, result: { rungs: fixed, fixed: true, reason: why ?? null } }
      }
      // package.sh encodes each rung at its target rate, not at constant quality, so rates measured at a constant quality
      // would be a claim about a different encode.
      if (kind !== 'shaka') return fallback('the ffmpeg packager uses a fixed table')
      const fps = ctx.shared.fps
      if (!fps) return fallback('frame rate unknown')
      let probe
      try {
        probe = await measure({
          mezzanine: ctx.shared.mezzanine,
          duration: info.duration,
          heights: candidateHeights(sourceHeight),
          crf: LADDER_CRF,
          gop: gopFrames(fps),
          tmp: join(work, `.ladder-${ctx.meta.uploadId}`),
          onProgress: h.progress,
        })
      } catch (e) {
        // A failed measurement must not fail the upload: the fixed ladder is always a valid answer.
        h.log(`complexity probe failed: ${e.message}`)
        return fallback('complexity probe failed')
      }
      const plan = planLadder(probe.measured, { aspect: info.video.displayWidth / info.video.displayHeight, fps })
      ctx.shared.ladder = { rungs: plan.rungs, crf: LADDER_CRF }
      const lo = plan.rungs[0].kbps
      const hi = plan.rungs[plan.rungs.length - 1].kbps
      return {
        summary: `${plan.rungs.length} rungs, ${lo}–${hi} kbps · ${plan.class} content`,
        result: {
          rungs: plan.rungs, class: plan.class, bpp: Number(plan.bpp.toFixed(4)), crf: LADDER_CRF,
          measured: probe.measured, dropped: plan.dropped, sampledSeconds: Number(probe.seconds.toFixed(1)), fixed: false,
        },
      }
    },

    async package(ctx, h) {
      const stage = staging(ctx)
      const { info, mezzanine } = ctx.shared
      await rm(stage, { recursive: true, force: true })
      await mkdir(stage, { recursive: true }) // the container needs it to exist to mount it
      const sourceHeight = Math.floor(info.video.displayHeight / 2) * 2
      const ladder = ctx.shared.ladder ?? { rungs: selectRungs(sourceHeight), crf: null }
      const { cmd, args, env } = packageCommand({
        kind,
        mezzanine,
        stage,
        outputId: ctx.meta.outputId,
        rungs: ladder.rungs,
        crf: ladder.crf,
        sourceHeight,
        scriptsDir: SCRIPTS_DIR,
        packageScript,
        image,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      })
      const { rungs } = ladder
      const tail = []
      await new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
        createInterface({ input: child.stdout }).on('line', (line) => {
          const p = parseProgressLine(line, info.duration)
          if (p !== null) return h.progress(p)
          if (isProgressNoise(line)) return
          h.log(line)
        })
        createInterface({ input: child.stderr }).on('line', (line) => {
          tail.push(line)
          if (tail.length > 20) tail.shift()
          h.log(line)
        })
        child.on('error', (spawnError) => reject(new Error(explainPackagerFailure(kind, { spawnError }))))
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(explainPackagerFailure(kind, { code, stderrTail: tail })))))
      }).catch(async (e) => {
        await rm(stage, { recursive: true, force: true })
        throw new StageError('E_PACKAGE_FAILED', e.message)
      })
      const bytes = await dirBytes(stage)
      return { summary: `${rungs.map((r) => `${r.height}p`).join(', ')} · ${mb(bytes)} · ${kind === 'shaka' ? 'Shaka Packager' : 'ffmpeg'}`, result: { rungs, bytes, packager: kind } }
    },

    async verify(ctx) {
      const stage = staging(ctx)
      const files = await readdir(stage)
      const master = await readFile(join(stage, 'master.m3u8'), 'utf8').catch(() => '')
      const playlists = {}
      for (const f of files.filter((n) => /^media_\d+\.m3u8$/.test(n))) playlists[f] = await readFile(join(stage, f), 'utf8')
      const mpd = await readFile(join(stage, 'manifest.mpd'), 'utf8').catch(() => undefined)
      const result = verifyPackage({ id: ctx.meta.outputId, files, master, playlists, mpd })
      if (!result.ok) {
        const failed = result.checks.filter((c) => !c.ok).map((c) => c.name)
        await rm(stage, { recursive: true, force: true })
        throw new StageError('E_VERIFY_FAILED', `failed: ${failed.join(', ')}`, { result })
      }
      return { summary: `${result.checks.length}/${result.checks.length} checks passed`, result }
    },

    async publish(ctx) {
      const stage = staging(ctx)
      const id = ctx.meta.outputId
      const target = join(origin, id)
      // Re-check ownership: the id was chosen when the upload arrived.
      const owner = await readFile(join(target, 'source.json'), 'utf8').then((t) => JSON.parse(t).sha256, () => null)
      if ((await exists(target)) && owner !== ctx.meta.sha256) throw new StageError('E_PUBLISH_CONFLICT', `origin/${id} belongs to something else`)
      await writeFile(join(stage, 'source.json'), JSON.stringify({ sha256: ctx.meta.sha256, name: ctx.meta.name, uploadId: ctx.meta.uploadId }, null, 2) + '\n')
      await rm(target, { recursive: true, force: true })
      await rename(stage, target)
      return { summary: `origin/${id}/`, result: { id, path: `origin/${id}`, urls: { hls: `/${id}/master.m3u8`, dash: `/${id}/manifest.mpd` } } }
    },
  }
}
