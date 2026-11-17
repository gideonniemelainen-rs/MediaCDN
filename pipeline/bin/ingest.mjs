#!/usr/bin/env node
// Ingest: probe, validate and normalise one upload into work/<jobKey>/mezzanine.mkv.
// usage: node pipeline/bin/ingest.mjs <file> [--id slug] [--work dir] [--profile file]
// exit codes: 0 ok, 1 usage/internal error, 2 rejected by validation, 3 normalise failed
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PIPELINE_VERSION, jobKey, slugify } from '../src/job.mjs'
import { planNormalise } from '../src/normalise.mjs'
import { probe } from '../src/probe.mjs'
import { validate } from '../src/validate.mjs'

const run = promisify(execFile)
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

const hashFile = (file) =>
  new Promise((ok, fail) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', fail)
  })

const opts = parseArgs(process.argv.slice(2))
if (!opts.file) {
  console.error('usage: ingest.mjs <file> [--id slug] [--work dir] [--profile file]')
  process.exit(1)
}

const profile = JSON.parse(await readFile(opts.profile, 'utf8'))
const id = opts.id ?? slugify(basename(opts.file))
const sourceSha = await hashFile(opts.file)
const key = jobKey(sourceSha, profile)
const dir = join(opts.work, key)
const jobFile = join(dir, 'job.json')
const mezzanine = join(dir, 'mezzanine.mkv')
await mkdir(dir, { recursive: true })

const job = { jobKey: key, id, pipelineVersion: PIPELINE_VERSION, profile: profile.name, source: { file: basename(opts.file), sha256: sourceSha } }
const save = (patch) => writeFile(jobFile, JSON.stringify(Object.assign(job, patch), null, 2) + '\n')

try {
  const done = JSON.parse(await readFile(jobFile, 'utf8'))
  if (done.status === 'normalised') {
    console.log(`${key}: already normalised, nothing to do`)
    process.exit(0)
  }
} catch {}

let info
try {
  info = await probe(opts.file)
} catch (e) {
  const errors = [{ code: 'E_UNREADABLE', detail: String(e.stderr ?? e.message).trim().split('\n')[0] }]
  await save({ status: 'rejected', errors, warnings: [] })
  console.error(`rejected: ${errors[0].code} ${errors[0].detail}`)
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
const plan = planNormalise(info, profile, { input: opts.file, output: tmp })
try {
  await run('ffmpeg', plan.args, { maxBuffer: 32 * 1024 * 1024 })
  await rename(tmp, mezzanine)
} catch (e) {
  await rm(tmp, { force: true })
  const detail = String(e.stderr ?? e.message).trim().split('\n').slice(-3).join(' | ')
  await save({ status: 'failed', errors: [{ code: 'E_DECODE_FAILED', detail }], warnings: verdict.warnings })
  console.error(`failed: E_DECODE_FAILED ${detail}`)
  process.exit(3)
}

await save({ status: 'normalised', errors: [], warnings: verdict.warnings, normalise: plan.decisions, mezzanine: 'mezzanine.mkv' })
console.log(`${key}: normalised ${id} (${verdict.warnings.map((w) => w.code).join(', ') || 'no warnings'}) -> ${mezzanine}`)
