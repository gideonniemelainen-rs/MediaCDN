// Display helpers for the upload page. Pure.
import type { Stage, StageStatus } from './types'

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m} m ${Math.round(s - m * 60)} s`
}

export function formatBytes(n: number): string {
  if (n < 1e3) return `${n} B`
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} kB`
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`
  return `${(n / 1e9).toFixed(2)} GB`
}

/** How long a stage has taken: its final time, a live time while running, null if it never started. */
export function stageElapsed(stage: Pick<Stage, 'status' | 'startedAt' | 'endedAt'>, now: number): number | null {
  if (stage.startedAt === null) return null
  if (stage.endedAt !== null) return Math.max(0, stage.endedAt - stage.startedAt)
  return stage.status === 'running' ? Math.max(0, now - stage.startedAt) : null
}

const WORDS: Record<StageStatus, string> = {
  queued: 'waiting',
  running: 'running',
  success: 'succeeded',
  failed: 'failed',
  skipped: 'skipped',
  cached: 'reused a cached result',
}
export const statusWord = (s: StageStatus): string => WORDS[s]

/** Screen-reader text for a node, e.g. "Probe: succeeded in 0.3 s". */
export function describeStage(stage: Stage, now: number): string {
  const t = stageElapsed(stage, now)
  const pct = stage.status === 'running' && stage.progress !== null ? `, ${Math.round(stage.progress * 100)}%` : ''
  return `${stage.label}: ${statusWord(stage.status)}${t === null ? '' : ` in ${formatDuration(t)}`}${pct}`
}

/**
 * The stage to show by default: the one running, else the one that failed, else the last that
 * finished, else the first.
 */
export function activeStageId(stages: Pick<Stage, 'id' | 'status'>[]): string | null {
  const find = (s: StageStatus) => stages.find((x) => x.status === s)
  const done = stages.filter((s) => s.status === 'success' || s.status === 'cached')
  return (find('running') ?? find('failed') ?? done.at(-1) ?? stages[0])?.id ?? null
}
