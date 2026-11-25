// Job manager for uploads: starts a job per uploaded file and runs it on the shared queue (one heavy job at a time).
// Snapshots, persistence and history are the job store's (jobstore.mjs).
import { join } from 'node:path'
import { createJobStore, isTerminal } from './jobstore.mjs'
import { createQueue } from './queue.mjs'
import { runJob } from './run.mjs'
import { finishStage, newJob, startStage } from './stages.mjs'

export { isTerminal }

export function summarise(job) {
  return { id: job.id, name: job.meta.name, status: job.status, createdAt: job.createdAt, outputId: job.meta.outputId, bytes: job.meta.bytes }
}

/** What a client may see of a job: no filesystem paths and no owner id. */
export const publicJob = (job) => {
  const { source: _source, userId: _userId, ...meta } = job.meta
  return { ...job, meta }
}

/**
 * `onChange(job)` (optional, may be async) is called when a job's state changes, in order per job.
 * It is for history storage: a failure is logged and never affects the job. `queue` is shared with the workflow runs.
 */
export async function createJobManager({ work, steps, now = Date.now, onChange, queue = createQueue() }) {
  const store = await createJobStore({ dir: join(work, 'jobs'), now, onChange })

  return {
    get: store.get,
    all: store.all,
    list: (visible = () => true) => store.list(visible, summarise),
    subscribe: store.subscribe,

    /** Registers an uploaded file as a job (its upload stage already done) and queues it. */
    create({ id, meta, upload }) {
      const t = now()
      let job = newJob({ id, meta, now: t })
      job = finishStage(startStage(job, 'upload', upload.startedAt), 'upload', { summary: upload.summary, result: upload.result }, upload.endedAt)
      store.publish(job)
      const ctx = { meta, shared: {} }
      queue.add(() => runJob(job, steps, ctx, { emit: store.publish, now }))
      return job
    },

    /** Resolves when every queued job has finished and its history writes have landed (for tests). */
    idle: async () => {
      await queue.idle()
      await store.idle()
    },
  }
}
