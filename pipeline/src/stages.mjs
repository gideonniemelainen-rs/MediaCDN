// Stage graph and job-snapshot transitions. A job is plain JSON that the UI renders as a workflow
// graph; every transition returns a new job, so they are pure and easy to test.
// Stage status: queued | running | success | failed | skipped | cached.

export const STAGES = [
  { id: 'upload', label: 'Upload', needs: [] },
  { id: 'probe', label: 'Probe', needs: ['upload'] },
  { id: 'validate', label: 'Validate', needs: ['probe'] },
  { id: 'normalise', label: 'Normalise', needs: ['validate'] },
  { id: 'ladder', label: 'Ladder', needs: ['normalise'] },
  { id: 'package', label: 'Package', needs: ['ladder'] },
  { id: 'verify', label: 'Verify', needs: ['package'] },
  { id: 'publish', label: 'Publish', needs: ['verify'] },
]

const DONE = new Set(['success', 'cached'])
const LOG_LINES = 60

export function deriveStatus(job) {
  const states = job.stages.map((s) => s.status)
  if (states.includes('failed')) return 'failed'
  if (states.every((s) => DONE.has(s))) return 'success'
  if (states.every((s) => s === 'queued')) return 'queued'
  return 'running'
}

export function newJob({ id, meta, now, stages = STAGES }) {
  const job = {
    id,
    status: 'queued',
    createdAt: now,
    meta,
    stages: stages.map((s) => ({
      id: s.id,
      label: s.label,
      needs: s.needs,
      status: 'queued',
      startedAt: null,
      endedAt: null,
      progress: null,
      summary: null,
      result: null,
      log: [],
    })),
  }
  return job
}

function patch(job, id, fields) {
  const next = { ...job, stages: job.stages.map((s) => (s.id === id ? { ...s, ...fields } : s)) }
  return { ...next, status: deriveStatus(next) }
}

export const startStage = (job, id, now) => patch(job, id, { status: 'running', startedAt: now, progress: null })

export const setProgress = (job, id, progress) => patch(job, id, { progress })

export function appendLog(job, id, line) {
  const stage = job.stages.find((s) => s.id === id)
  return patch(job, id, { log: [...stage.log, line].slice(-LOG_LINES) })
}

export function finishStage(job, id, { status = 'success', summary = null, result = null }, now) {
  const stage = job.stages.find((s) => s.id === id)
  return patch(job, id, {
    status,
    summary,
    result,
    endedAt: now,
    startedAt: stage.startedAt ?? now,
    progress: status === 'failed' ? stage.progress : 1,
  })
}

/** Stages that have not started and whose dependencies are all done. */
export function readyStages(job) {
  const done = new Set(job.stages.filter((s) => DONE.has(s.status)).map((s) => s.id))
  return job.stages.filter((s) => s.status === 'queued' && s.needs.every((n) => done.has(n)))
}

/** After a failure, everything that (transitively) needs a failed or skipped stage is skipped. */
export function skipDownstream(job, now) {
  let current = job
  for (let changed = true; changed; ) {
    changed = false
    const blocked = new Set(current.stages.filter((s) => s.status === 'failed' || s.status === 'skipped').map((s) => s.id))
    for (const s of current.stages) {
      if (s.status === 'queued' && s.needs.some((n) => blocked.has(n))) {
        current = patch(current, s.id, { status: 'skipped', endedAt: now })
        changed = true
      }
    }
  }
  return current
}
