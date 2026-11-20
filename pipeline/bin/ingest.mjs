#!/usr/bin/env node
// Ingest: probe, validate and normalise one upload into work/<jobKey>/mezzanine.mkv.
// usage: node pipeline/bin/ingest.mjs <file> [--id slug] [--work dir] [--profile file]
// exit codes: 0 ok, 1 usage/internal error, 2 rejected by validation, 3 normalise failed
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IngestError, hashFile, jobPaths, normaliseFile, probeFile, readJob, writeJob } from '../src/ingest.mjs'
import { PIPELINE_VERSION, jobKey, slugify } from '../src/job.mjs'
import { validate } from '../src/validate.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

function parseArgs(argv) {
  const opts = { work: join(root, 'work'), profile: join(root, 'profiles/default.json') }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') opts.id = argv[++i]
    else if (argv[i] === '--work') opts.work = resolve(argv[++i])
    else if (argv[i] === '--profile') opts.profile = resolve(argv[++i])
    else rest.push(argv[i])
  }
  opts.file = rest[0]
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.file) {
  console.error('usage: ingest.mjs <file> [--id slug] [--work dir] [--profile file]')
  process.exit(1)
}

const profile = JSON.parse(await readFile(opts.profile, 'utf8'))
const id = opts.id ?? slugify(basename(opts.file))
const sourceSha = await hashFile(opts.file)
const key = jobKey(sourceSha, profile)
const { dir, jobFile, mezzanine } = jobPaths(opts.work, key)
await mkdir(dir, { recursive: true })

const job = { jobKey: key, id, pipelineVersion: PIPELINE_VERSION, profile: profile.name, source: { file: basename(opts.file), sha256: sourceSha } }
const save = (patch) => writeJob(jobFile, Object.assign(job, patch))

if ((await readJob(jobFile))?.status === 'normalised') {
  console.log(`${key}: already normalised, nothing to do`)
  process.exit(0)
}

let info
try {
  info = await probeFile(opts.file)
} catch (e) {
  if (!(e instanceof IngestError)) throw e
  await save({ status: 'rejected', errors: [{ code: e.code, detail: e.detail }], warnings: [] })
  console.error(`rejected: ${e.code} ${e.detail}`)
  process.exit(2)
}

const verdict = validate(info, profile.limits)
job.source = { ...job.source, bytes: info.bytes, info }
if (!verdict.ok) {
  await save({ status: 'rejected', errors: verdict.errors, warnings: verdict.warnings })
  for (const e of verdict.errors) console.error(`rejected: ${e.code} ${e.message}${e.detail ? ` (${e.detail})` : ''}`)
  process.exit(2)
}

const tmp = `${mezzanine}.part`
let plan
try {
  plan = await normaliseFile({ file: opts.file, info, profile, output: tmp })
  await rename(tmp, mezzanine)
} catch (e) {
  await rm(tmp, { force: true })
  const detail = e instanceof IngestError ? e.detail : e.message
  await save({ status: 'failed', errors: [{ code: 'E_DECODE_FAILED', detail }], warnings: verdict.warnings })
  console.error(`failed: E_DECODE_FAILED ${detail}`)
  process.exit(3)
}

await save({ status: 'normalised', errors: [], warnings: verdict.warnings, normalise: plan.decisions, mezzanine: 'mezzanine.mkv' })
console.log(`${key}: normalised ${id} (${verdict.warnings.map((w) => w.code).join(', ') || 'no warnings'}) -> ${mezzanine}`)
