// Where job snapshots live: in memory, on disk (<dir>/<id>.json) and, through `onChange`, in the history database. The
// upload job manager and the workflow run manager both sit on one. A snapshot is plain JSON (see stages.mjs).
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { finishStage, skipDownstream, startStage } from './stages.mjs'

const TERMINAL = new Set(['success', 'failed'])
export const isTerminal = (job) => TERMINAL.has(job.status)

/** Changes worth recording: a stage or the job changing state, not progress ticks. */
const signature = (job) => `${job.status}|${job.stages.map((s) => s.status).join(',')}`

/**
 * `onChange(job)` (optional, may be async) is called when a job's state changes, in order per job. It is for history
 * storage: a failure is logged and never affects the job. Jobs left half-done by a restart are shown as failed.
 */
export async function createJobStore({ dir, now = Date.now, onChange }) {
  await mkdir(dir, { recursive: true })
  const jobs = new Map()
  const subs = new Map()
  const writing = new Map()

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
    /** Newest first, through `view` (what a list shows of a job). */
    list: (visible, view) => [...jobs.values()].filter(visible).sort((a, b) => b.createdAt - a.createdAt).map(view),

    subscribe(id, fn) {
      if (!subs.has(id)) subs.set(id, new Set())
      subs.get(id).add(fn)
      return () => subs.get(id)?.delete(fn)
    },

    /** Records a new or changed snapshot: memory, disk, history, subscribers. */
    publish(job) {
      jobs.set(job.id, job)
      persist(job)
      notify(job)
      for (const fn of subs.get(job.id) ?? []) fn(job)
    },

    /** Resolves when every history write so far has landed (for tests). */
    idle: () => Promise.all(syncing.values()).then(() => {}),
  }
}
