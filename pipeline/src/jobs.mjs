// Job manager: keeps job snapshots in memory and on disk (work/jobs/<id>.json), runs one job at a
// time (ffmpeg is heavy), and lets the HTTP layer subscribe to changes.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runJob } from './run.mjs'
import { finishStage, newJob, skipDownstream, startStage } from './stages.mjs'

const TERMINAL = new Set(['success', 'failed'])
export const isTerminal = (job) => TERMINAL.has(job.status)

export function summarise(job) {
  return { id: job.id, name: job.meta.name, status: job.status, createdAt: job.createdAt, outputId: job.meta.outputId, bytes: job.meta.bytes }
}

/** What a client may see of a job: no filesystem paths and no owner id. */
export const publicJob = (job) => {
  const { source: _source, userId: _userId, ...meta } = job.meta
  return { ...job, meta }
}

/** Changes worth recording: a stage or the job changing state, not progress ticks. */
const signature = (job) => `${job.status}|${job.stages.map((s) => s.status).join(',')}`

/**
 * `onChange(job)` (optional, may be async) is called when a job's state changes, in order per job.
 * It is for history storage: a failure is logged and never affects the job.
 */
export async function createJobManager({ work, steps, now = Date.now, onChange }) {
  const dir = join(work, 'jobs')
  await mkdir(dir, { recursive: true })
  const jobs = new Map()
  const subs = new Map()
  const writing = new Map()
  let tail = Promise.resolve()

  // Persist coalesced: at most one write in flight per job, then once more if it changed meanwhile.
  function persist(job) {
    const state = writing.get(job.id)
    if (state) return void (state.dirty = job)
    const st = { dirty: null }
    writing.set(job.id, st)
    const file = join(dir, `${job.id}.json`)
    writeFile(`${file}.part`, JSON.stringify(job))
      .then(() => rename(`${file}.part`, file))
      .catch(() => {})
      .finally(() => {
        writing.delete(job.id)
        if (st.dirty) persist(st.dirty)
      })
  }

  const signed = new Map()
  const syncing = new Map()
  function notify(job) {
    if (!onChange) return
    const sig = signature(job)
    if (signed.get(job.id) === sig) return
    signed.set(job.id, sig)
    const run = (syncing.get(job.id) ?? Promise.resolve())
      .then(() => onChange(job))
      .catch((e) => console.error(`history: could not record job ${job.id}: ${e.message}`))
    syncing.set(job.id, run)
  }

  function publish(job) {
    jobs.set(job.id, job)
    persist(job)
    notify(job)
    for (const fn of subs.get(job.id) ?? []) fn(job)
  }

  // A restart leaves jobs half-done: show them as failed rather than forever running.
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json')) continue
    let job
    try {
      job = JSON.parse(await readFile(join(dir, f), 'utf8'))
    } catch {
      continue
    }
    if (!isTerminal(job)) {
      const t = now()
      for (const s of job.stages) {
        if (s.status === 'running') job = finishStage(job, s.id, { status: 'failed', summary: 'interrupted by a server restart', result: { code: 'E_INTERRUPTED' } }, t)
      }
      if (!isTerminal(job)) {
        // Still queued: it never started. Fail the first queued stage so the job ends visibly.
        const first = job.stages.find((s) => s.status === 'queued')
        if (first) job = finishStage(startStage(job, first.id, t), first.id, { status: 'failed', summary: 'interrupted by a server restart', result: { code: 'E_INTERRUPTED' } }, t)
      }
      job = skipDownstream(job, t)
    }
    jobs.set(job.id, job)
  }

  return {
    get: (id) => jobs.get(id),
    /** Every job, oldest first (for the startup backfill). */
    all: () => [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt),
    list: (visible = () => true) => [...jobs.values()].filter(visible).sort((a, b) => b.createdAt - a.createdAt).map(summarise),

    subscribe(id, fn) {
      if (!subs.has(id)) subs.set(id, new Set())
      subs.get(id).add(fn)
      return () => subs.get(id)?.delete(fn)
    },

    /** Registers an uploaded file as a job (its upload stage already done) and queues it. */
    create({ id, meta, upload }) {
      const t = now()
      let job = newJob({ id, meta, now: t })
      job = finishStage(startStage(job, 'upload', upload.startedAt), 'upload', { summary: upload.summary, result: upload.result }, upload.endedAt)
      publish(job)
      const ctx = { meta, shared: {} }
      tail = tail.then(() => runJob(job, steps, ctx, { emit: publish, now })).catch(() => {})
      return job
    },

    /** Resolves when every queued job has finished and its history writes have landed (for tests). */
    idle: async () => {
      await tail
      await Promise.all(syncing.values())
    },
  }
}
