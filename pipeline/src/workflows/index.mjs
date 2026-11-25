// What each runnable Workflow does (the registry's data is shared/src/workflows.ts). Each entry is
// `steps({ params, dryRun })` returning the step function for each stage id, as runJob expects. Most run an existing script
// as a child process, so the script stays usable by hand; the benchmark is a function call. Parameters arrive validated.
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectRungs } from '../../../shared/src/ladder.ts'
import { runBench, parseTargets, summaryLines } from '../../../tools/bench-run.mjs'
import { sourceHeight } from '../../../scripts/package-title.mjs'
import { StageError } from '../run.mjs'
import { verifyTitleDir } from '../verify-dir.mjs'
import { spawnStage } from './spawn.mjs'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

const lastLine = (lines, fallback) => [...lines].reverse().find((l) => l.trim())?.trim() ?? fallback
const exists = (p) => stat(p).then(() => true, () => false)

/**
 * @param {object} [o]
 * @param {string} [o.root]       the repository root (the scripts, media/ and origin/ are found under it)
 * @param {string} [o.mediaDir]   where source files are (default <root>/media/src)
 * @param {string} [o.originDir]  where Titles are (default <root>/origin)
 * @param {Record<string, string>} [o.env]  extra environment for the child processes
 * @param {Record<string, string|undefined>} [o.hostEnv]  where the S3 workflows find the host's AWS profile settings
 */
export function createWorkflows({ root = REPO, mediaDir = join(root, 'media/src'), originDir = join(root, 'origin'), env = {}, bench = runBench, hostEnv = process.env } = {}) {
  const node = process.execPath
  const script = (...parts) => join(root, ...parts)
  const run = (file, args, h, extra = {}) => spawnStage({ cmd: node, args: [script(file), ...args], cwd: root, env: { ...env, ...extra }, h })

  // What the S3 workflows hand the AWS CLI: the bucket, and where the host's profile lives (HOME and the config file
  // locations, so the profile in ~/.aws resolves). Never an access key: credentials come from the profile, not from here.
  const PROFILE_VARS = ['HOME', 'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_REGION', 'AWS_DEFAULT_REGION']
  const awsEnv = (bucket) => ({ ...Object.fromEntries(PROFILE_VARS.filter((k) => hostEnv[k]).map((k) => [k, hostEnv[k]])), S3_BUCKET: bucket })
  const bash = (file, args, h, extra) => spawnStage({ cmd: 'bash', args: [script(file), ...args], cwd: root, env: { ...env, ...extra }, h })
  const counted = (lines) => lines.filter((l) => /^(\(dryrun\) )?upload:/.test(l)).length

  return {
    'probe-sources': {
      steps: ({ params }) => ({
        async probe(_ctx, h) {
          const { lines } = await run('scripts/probe-sources.mjs', [params.origin], h)
          return { summary: lastLine(lines, 'probed') }
        },
      }),
    },

    'fetch-sources': {
      steps: ({ params }) => ({
        async fetch(_ctx, h) {
          const ids = params.ids ?? []
          const known = new Set(JSON.parse(await readFile(script('media/sources.json'), 'utf8')).titles.map((t) => t.id))
          const unknown = ids.filter((id) => !known.has(id))
          if (unknown.length) throw new StageError('E_UNKNOWN_ID', `not in media/sources.json: ${unknown.join(', ')}`)
          const { lines } = await run('scripts/fetch-sources.mjs', ids, h)
          const count = (word) => lines.filter((l) => l.startsWith(word)).length
          return { summary: `${count('got')} downloaded, ${count('have')} already there` }
        },
      }),
    },

    'package-title': {
      steps: ({ params }) => {
        const id = params.id
        const input = join(mediaDir, `${id}.mp4`)
        return {
          async probe(ctx) {
            if (!(await exists(input))) throw new StageError('E_NO_SOURCE', `${input} not found; run "Fetch sources" first`)
            const height = sourceHeight(input)
            const rungs = selectRungs(height, { quick: params.quick })
            ctx.shared.rungs = rungs
            return { summary: `${height}p source, ${rungs.map((r) => `${r.height}p`).join(', ')}`, result: { height, rungs } }
          },
          // Packaged beside the Title and swapped in once it verifies, so a failed run leaves the old Title in place.
          async package(ctx, h) {
            const stage = join(originDir, `.tmp-run-${ctx.meta.workflow}-${id}`)
            ctx.shared.stage = stage
            await rm(stage, { recursive: true, force: true })
            try {
              await run('scripts/package-title.mjs', [id, ...(params.quick ? ['--quick'] : [])], h, { INPUT: input, OUT: stage })
            } catch (e) {
              await rm(stage, { recursive: true, force: true })
              throw e
            }
            return { summary: `${ctx.shared.rungs.length} rungs written` }
          },
          async verify(ctx) {
            const { stage } = ctx.shared
            const result = await verifyTitleDir(stage, id)
            if (!result.ok) {
              await rm(stage, { recursive: true, force: true })
              throw new StageError('E_VERIFY_FAILED', `failed: ${result.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`, { result })
            }
            const target = join(originDir, id)
            await rm(target, { recursive: true, force: true })
            await rename(stage, target)
            return { summary: `${result.checks.length}/${result.checks.length} checks passed, now at origin/${id}/`, result }
          },
        }
      },
    },

    'make-ads': {
      steps: ({ params }) => ({
        async make(_ctx, h) {
          const { lines } = await run('scripts/make-ads.mjs', params.ids ?? [], h)
          return { summary: lastLine(lines, 'done') }
        },
      }),
    },

    'smoke-origin': {
      steps: ({ params }) => ({
        async smoke(_ctx, h) {
          const { lines } = await run('tools/smoke-origin.mjs', params.slug ? [params.slug] : [], h)
          return { summary: lastLine(lines, 'passed') }
        },
      }),
    },

    bench: {
      steps: ({ params }) => ({
        async run(ctx, h) {
          const rates = JSON.parse(await readFile(script('bench/rates.json'), 'utf8'))
          const targets = parseTargets(params.targets)
          const report = await bench({ targets, slug: params.slug, rounds: params.rounds, segments: params.segments, rates, originDir }, { log: h.log, progress: h.progress })
          ctx.shared.report = report
          const lines = summaryLines(report)
          lines.forEach((l) => h.log(l))
          return { summary: `${targets.length} targets, ${params.rounds} rounds of ${report.config.segments} segments`, result: { lines } }
        },
        // The report belongs to the run (work/runs/<id>/report.json); bench/report.json stays the CLI's output.
        async report(ctx) {
          const file = join(ctx.dir, 'report.json')
          await mkdir(ctx.dir, { recursive: true })
          const text = JSON.stringify(ctx.shared.report, null, 2) + '\n'
          await writeFile(file, text)
          return { summary: 'report.json', result: { file: 'report.json', bytes: text.length } }
        },
      }),
    },

    // The two S3 workflows are gated: without `confirm` they only look (the dry run), and a real run needs the id of a
    // successful dry run (the run manager checks it). The steps below are chosen by `dryRun`, so the dry run's steps cannot
    // pass --go however they are called.
    'upload-s3': {
      steps: ({ params, dryRun }) => {
        const e = awsEnv(params.bucket)
        if (dryRun) {
          return {
            async 'dry-run'(_ctx, h) {
              const { lines } = await bash('scripts/upload-s3.sh', [params.slug], h, e)
              const size = lines.find((l) => l.startsWith('size:'))?.slice(5).trim()
              return { summary: `would upload ${counted(lines)} files${size ? ` (${size})` : ''} to s3://${params.bucket}/media/${params.slug}/`, result: { files: counted(lines), size: size ?? null } }
            },
          }
        }
        return {
          async upload(_ctx, h) {
            const { lines } = await bash('scripts/upload-s3.sh', [params.slug, '--go', '--no-index'], h, e)
            return { summary: `uploaded ${counted(lines)} files to s3://${params.bucket}/media/${params.slug}/` }
          },
          async index(_ctx, h) {
            const { lines } = await run('tools/s3-index.mjs', ['--go'], h, e)
            return { summary: lastLine(lines, 'index uploaded') }
          },
        }
      },
    },

    'rebuild-s3-index': {
      steps: ({ params, dryRun }) => {
        const e = awsEnv(params.bucket)
        if (dryRun) {
          return {
            async 'dry-run'(_ctx, h) {
              const { lines } = await run('tools/s3-index.mjs', [], h, e)
              const titles = lines.filter((l) => /^\s+"id":/.test(l)).length
              return { summary: `would list ${titles} titles in s3://${params.bucket}/media/index.json`, result: { titles } }
            },
          }
        }
        return {
          async index(_ctx, h) {
            const { lines } = await run('tools/s3-index.mjs', ['--go'], h, e)
            return { summary: lastLine(lines, 'index uploaded') }
          },
        }
      },
    },
  }
}
