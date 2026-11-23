// Ingest building blocks shared by the CLI (bin/ingest.mjs) and the upload server: probe,
// normalise with progress, and the job.json record that makes re-ingesting the same file a no-op.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { planNormalise } from './normalise.mjs'
import { probe } from './probe.mjs'

/** A failure with a stable code and the CLI exit code that goes with it (2 rejected, 3 failed). */
export class IngestError extends Error {
  constructor(code, detail, exitCode) {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
    this.detail = detail
    this.exitCode = exitCode
  }
}

export const hashFile = (file) =>
  new Promise((ok, fail) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', fail)
  })

export const jobPaths = (work, key) => {
  const dir = join(work, key)
  return { dir, jobFile: join(dir, 'job.json'), mezzanine: join(dir, 'mezzanine.mkv') }
}

export async function readJob(jobFile) {
  try {
    return JSON.parse(await readFile(jobFile, 'utf8'))
  } catch {
    return null
  }
}

export const writeJob = (jobFile, job) => writeFile(jobFile, JSON.stringify(job, null, 2) + '\n')

/** ffprobe a file; an unreadable container becomes a coded rejection. */
export async function probeFile(file) {
  try {
    return await probe(file)
  } catch (e) {
    throw new IngestError('E_UNREADABLE', String(e.stderr ?? e.message).trim().split('\n')[0], 2)
  }
}

/**
 * Progress of an ffmpeg `-progress` stream as a 0..1 fraction, or null for lines that carry none.
 * `out_time_ms` is in microseconds despite its name, the same as `out_time_us`.
 */
export function parseProgressLine(line, durationSec) {
  if (line === 'progress=end') return 1
  const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line)
  if (m && durationSec > 0) return Math.min(1, Number(m[1]) / 1e6 / durationSec)
  return null
}

/**
 * The rest of ffmpeg's `-progress` key=value block (`bitrate=   0.1kbits/s`, `speed=N/A`, `fps=0.00`).
 * ffmpeg pads some values with spaces, so these are not single tokens; none of them belong in a log.
 */
export const isProgressNoise = (line) => /^[a-z_0-9]+=\s*\S*$/.test(line)

/** Runs the normalise plan, reporting progress. Resolves with the plan (its `decisions` are recorded). */
export function normaliseFile({ file, info, profile, output, onProgress }) {
  const plan = planNormalise(info, profile, { input: file, output })
  const args = ['-progress', 'pipe:1', '-nostats', ...plan.args]
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const tail = []
    createInterface({ input: child.stdout }).on('line', (line) => {
      const p = parseProgressLine(line, info.duration)
      if (p !== null) onProgress?.(p)
    })
    createInterface({ input: child.stderr }).on('line', (line) => {
      tail.push(line)
      if (tail.length > 20) tail.shift()
    })
    child.on('error', (e) => reject(new IngestError('E_DECODE_FAILED', e.message, 3)))
    child.on('close', (code) =>
      code === 0 ? resolve(plan) : reject(new IngestError('E_DECODE_FAILED', tail.slice(-3).join(' | '), 3)),
    )
  })
}
