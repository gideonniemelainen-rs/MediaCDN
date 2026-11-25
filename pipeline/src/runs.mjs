// Run manager for Workflows: starts a run of a workflow with validated parameters and runs its stages on the shared queue,
// as the job manager does for uploads. A run is a job (same snapshot, same stage graph, same live log and progress), so
// the page that draws an upload draws a run. Snapshots, persistence and history are the job store's (jobstore.mjs).
//
// `workflows[id].steps({ params, dryRun })` returns the step functions by stage id (see runJob). The stage list itself
// comes from the registry (shared/src/workflows.ts), so what the page draws and what runs cannot disagree.
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKFLOWS, isDryRun, isWorkflowId, stagesFor } from '../../shared/src/workflows.ts'
import { createJobStore } from './jobstore.mjs'
import { createQueue } from './queue.mjs'
import { runJob } from './run.mjs'
import { newJob } from './stages.mjs'

export class UnknownWorkflow extends Error {
  constructor(id) {
    super(`no runnable workflow "${id}"`)
    this.status = 404
  }
}

export function summariseRun(job) {
  return { id: job.id, workflow: job.meta.workflow, name: job.meta.name, status: job.status, createdAt: job.createdAt, dryRun: job.meta.dryRun, params: job.meta.params }
}

/** What a client may see of a run: no owner id. */
export const publicRun = (job) => {
  const { userId: _userId, ...meta } = job.meta
  return { ...job, meta }
}

/**
 * `onChange(job)` is as for the job manager (history). `queue` is shared with the upload jobs. Each run gets a directory,
 * `<work>/runs/<id>/`, as `ctx.dir`, for what it produces (a benchmark report).
 */
export async function createRunManager({ work, workflows, queue = createQueue(), now = Date.now, onChange, newId = () => randomBytes(4).toString('hex') }) {
  const dir = join(work, 'runs')
  const store = await createJobStore({ dir, now, onChange })

  return {
    get: store.get,
    all: store.all,
    list: (visible = () => true) => store.list(visible, summariseRun),
    subscribe: store.subscribe,

    /** Queues a run of `workflow` with parameters the caller has already validated against the registry. */
    start({ workflow, params, userId = null }) {
      if (!isWorkflowId(workflow) || WORKFLOWS[workflow].kind !== 'run' || !workflows[workflow]) throw new UnknownWorkflow(workflow)
      const id = newId()
      const dryRun = isDryRun(workflow, params)
      const meta = { workflow, name: WORKFLOWS[workflow].label, params, dryRun, userId }
      const job = newJob({ id, meta, now: now(), stages: stagesFor(workflow, params) })
      store.publish(job)
      const runDir = join(dir, id)
      queue.add(async () => {
        await mkdir(runDir, { recursive: true })
        const steps = workflows[workflow].steps({ params, dryRun })
        return runJob(job, steps, { meta, params, dir: runDir, shared: {} }, { emit: store.publish, now })
      })
      return job
    },

    /** Resolves when every queued run has finished and its history writes have landed (for tests). */
    idle: async () => {
      await queue.idle()
      await store.idle()
    },
  }
}
