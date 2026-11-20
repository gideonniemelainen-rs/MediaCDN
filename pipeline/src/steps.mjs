// The stage implementations the upload server runs (the `upload` stage is completed by the
// server itself as the file arrives). Each step gets `ctx` = { meta, shared } and the runner's
// progress/log helpers, and returns { status?, summary, result } or throws a coded error.
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { IngestError, jobPaths, normaliseFile, parseProgressLine, probeFile, readJob, writeJob } from './ingest.mjs'
import { PIPELINE_VERSION, jobKey } from './job.mjs'
import { chooseOutputId, parseRungsLine, verifyPackage } from './package.mjs'
import { StageError } from './run.mjs'
import { validate } from './validate.mjs'

const PACKAGE_SCRIPT = fileURLToPath(new URL('../../scripts/package.sh', import.meta.url))
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

export function createSteps({ profile, work, origin, packageScript = PACKAGE_SCRIPT }) {
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
      const bits = [`${d.fps} fps constant`, d.audio.synthesised ? 'silent audio added' : 'audio kept']
      if (d.tonemapped) bits.push('HDR tonemapped')
      if (d.rotated) bits.push(`rotated ${d.rotated}°`)
      return { summary: `${bits.join(', ')}, ${mb(bytes)}`, result: { key, decisions: d, mezzanineBytes: bytes } }
    },

    async package(ctx, h) {
      const stage = staging(ctx)
      const { info, mezzanine } = ctx.shared
      await rm(stage, { recursive: true, force: true })
      let rungs = []
      const tail = []
      await new Promise((resolve, reject) => {
        const child = spawn('bash', [packageScript, ctx.meta.outputId], {
          env: { ...process.env, INPUT: mezzanine, OUT: stage, PROGRESS: 'pipe:1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        createInterface({ input: child.stdout }).on('line', (line) => {
          const p = parseProgressLine(line, info.duration)
          if (p !== null) return h.progress(p)
          if (/^[a-z_0-9]+=\S*$/.test(line)) return // the rest of ffmpeg's key=value progress block
          rungs = parseRungsLine(line) ?? rungs
          h.log(line)
        })
        createInterface({ input: child.stderr }).on('line', (line) => {
          tail.push(line)
          if (tail.length > 20) tail.shift()
          h.log(line)
        })
        child.on('error', reject)
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(tail.slice(-3).join(' | ') || `package.sh exited ${code}`))))
      }).catch(async (e) => {
        await rm(stage, { recursive: true, force: true })
        throw new StageError('E_PACKAGE_FAILED', e.message)
      })
      ctx.shared.rungs = rungs
      const bytes = await dirBytes(stage)
      return { summary: `${rungs.map((r) => `${r.height}p`).join(', ')} · ${mb(bytes)}`, result: { rungs, bytes } }
    },

    async verify(ctx) {
      const stage = staging(ctx)
      const files = await readdir(stage)
      const master = await readFile(join(stage, 'master.m3u8'), 'utf8').catch(() => '')
      const playlists = {}
      for (const f of files.filter((n) => /^media_\d+\.m3u8$/.test(n))) playlists[f] = await readFile(join(stage, f), 'utf8')
      const result = verifyPackage({ id: ctx.meta.outputId, files, master, playlists })
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
