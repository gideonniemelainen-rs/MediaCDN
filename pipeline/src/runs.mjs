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

/** A start that the rules refuse (409): the reason is meant to be shown to the person who asked. */
export class RunRefused extends Error {
  constructor(message) {
    super(message)
    this.status = 409
  }
}

export const CONFIRM_WINDOW_MS = 15 * 60 * 1000

const sameParams = (a, b) => {
  const strip = ({ confirm: _c, ...rest }) => JSON.stringify(Object.entries(rest).sort(([x], [y]) => (x < y ? -1 : 1)))
  return strip(a) === strip(b)
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
export async function createRunManager({ work, workflows, queue = createQueue(), now = Date.now, onChange, confirmWindowMs = CONFIRM_WINDOW_MS, newId = () => randomBytes(4).toString('hex') }) {
  const dir = join(work, 'runs')
  const store = await createJobStore({ dir, now, onChange })

  /**
   * The gate on a real run of a dry-run-then-confirm workflow: `confirm` must name a successful dry run of the same
   * workflow with the same parameters, started by the same user, that ended within the window and has not been used. This
   * is the rule, not the page: a call that skips the dry run is refused here. Using a dry run, even by a run that then
   * fails, spends it, and the record of that is the run's own `confirm` param, so a restart does not forget it.
   */
  function checkConfirm(workflow, params, userId) {
    const dry = store.get(params.confirm)
    const refuse = (why) => {
      throw new RunRefused(`cannot confirm ${params.confirm}: ${why}`)
    }
    if (!dry || dry.meta.workflow !== workflow) refuse('no such dry run of this workflow')
    if (!dry.meta.dryRun) refuse('that run was not a dry run')
    if (dry.status !== 'success') refuse(`the dry run ${dry.status === 'failed' ? 'failed' : 'has not finished'}`)
    if ((dry.meta.userId ?? null) !== (userId ?? null)) refuse('the dry run was started by someone else')
    if (!sameParams(dry.meta.params, params)) refuse('the parameters differ from the dry run, so run the dry run again')
    const endedAt = Math.max(dry.createdAt, ...dry.stages.map((s) => s.endedAt ?? 0))
    if (now() - endedAt > confirmWindowMs) refuse(`the dry run is more than ${Math.round(confirmWindowMs / 60000)} minutes old, so run it again`)
    if (store.all().some((j) => j.id !== dry.id && j.meta.workflow === workflow && j.meta.params?.confirm === dry.id)) refuse('it was already used')
  }

  return {
    get: store.get,
    all: store.all,
    list: (visible = () => true) => store.list(visible, summariseRun),
    subscribe: store.subscribe,

    /** Queues a run of `workflow` with parameters the caller has already validated against the registry. */
    start({ workflow, params, userId = null }) {
      if (!isWorkflowId(workflow) || WORKFLOWS[workflow].kind !== 'run' || !workflows[workflow]) throw new UnknownWorkflow(workflow)
      if (params.confirm !== undefined) checkConfirm(workflow, params, userId)
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
