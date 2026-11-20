// While a file is still uploading there is no job yet, so the graph is drawn from the server's
// stage definitions with the upload stage running. Pure.
import type { Stage, StageDef } from './types'

export function draftStages(defs: StageDef[], upload: { startedAt: number; loaded: number; total: number }): Stage[] {
  return defs.map((d) => ({
    ...d,
    status: d.id === 'upload' ? 'running' : 'queued',
    startedAt: d.id === 'upload' ? upload.startedAt : null,
    endedAt: null,
    progress: d.id === 'upload' && upload.total > 0 ? upload.loaded / upload.total : null,
    summary: null,
    result: null,
    log: [],
  }))
}
