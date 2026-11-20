// Job runner: executes the stages of a job in dependency order and emits a full snapshot after
// every change. A stage that throws fails, and everything downstream of it is skipped.
import { appendLog, finishStage, readyStages, setProgress, skipDownstream, startStage } from './stages.mjs'

/** A failure with a stable code (and optionally a result to show in the UI). */
export class StageError extends Error {
  constructor(code, message, { result } = {}) {
    super(message)
    this.code = code
    this.result = result
  }
}

/**
 * `steps[stageId](ctx, helpers)` returns `{ status?, summary?, result? }` (status defaults to
 * `success`; a step reports a cache hit as `cached`). Helpers: `progress(0..1)` and `log(line)`.
 * Stages whose dependencies are done run together, so a fan-out in the graph runs in parallel.
 */
export async function runJob(job, steps, ctx, { emit = () => {}, now = Date.now, progressEveryMs = 200 } = {}) {
  let current = job
  const update = (fn) => {
    current = fn(current)
    emit(current)
  }

  for (;;) {
    const ready = readyStages(current)
    if (!ready.length) break
    await Promise.all(
      ready.map(async ({ id }) => {
        update((j) => startStage(j, id, now()))
        let lastEmit = 0
        const throttled = (fn) => {
          const t = now()
          if (t - lastEmit < progressEveryMs) current = fn(current)
          else {
            lastEmit = t
            update(fn)
          }
        }
        const helpers = {
          progress: (p) => throttled((j) => setProgress(j, id, Math.max(0, Math.min(1, p)))),
          log: (line) => throttled((j) => appendLog(j, id, line)),
        }
        try {
          const step = steps[id]
          if (!step) throw new StageError('E_NO_STEP', `no step implemented for ${id}`)
          const out = (await step(ctx, helpers)) ?? {}
          update((j) => finishStage(j, id, { status: out.status ?? 'success', summary: out.summary, result: out.result }, now()))
        } catch (e) {
          const result = { code: e.code ?? 'E_INTERNAL', ...(e.result ?? {}) }
          update((j) => skipDownstream(finishStage(j, id, { status: 'failed', summary: e.message, result }, now()), now()))
        }
      }),
    )
  }
  return current
}
