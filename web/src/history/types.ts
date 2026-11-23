// Shapes of the pipeline server's history routes (pipeline/src/db/uploads.mjs).
import type { Summary } from '../telemetry/metrics'
import type { TelemetryEvent } from '../telemetry/types'
import type { JobStatus } from '../upload/types'

export interface UploadRow {
  id: string
  name: string
  status: JobStatus
  bytes: number | null
  sha256: string | null
  outputId: string | null
  createdAt: number
  endedAt: number | null
  durationMs: number | null
  errorCode: string | null
  /** Username of whoever uploaded it. */
  owner: string
}

export interface UploadPage {
  uploads: UploadRow[]
  /** Cursor for the next (older) page, null on the last one. */
  next: string | null
}

/** The figures kept per quadrant as columns (see pipeline/src/benchmarks.mjs METRICS). */
export interface RunSession {
  slot: number
  streamId: string
  delivery: string
  startupMs: number | null
  rebufferCount: number | null
  rebufferRatio: number | null
  avgBitrateKbps: number | null
  meanSegmentLatencyMs: number | null
  throughputKbps: number | null
  errors: number | null
}

export interface RunRow {
  id: string
  label: string
  startedAt: number
  endedAt: number
  env: Record<string, unknown>
  owner: string
  /** The list view carries only the identity of each quadrant. */
  sessions: Pick<RunSession, 'slot' | 'streamId' | 'delivery'>[]
}

export interface RunPage {
  runs: RunRow[]
  next: string | null
}

export interface RunDetail extends Omit<RunRow, 'sessions'> {
  sessions: RunSession[]
  artifacts: { kind: string; schemaVersion: number; bytes: number }[]
}

/** What is saved with a run so the comparison can be rebuilt: the events and the clock they were measured against. */
export interface EventsBlob {
  schemaVersion: number
  timeOrigin: number
  nowMs: number
  events: TelemetryEvent[]
  downsampled?: { sampleEvents: { from: number; to: number } }
}

/** The body of POST /benchmarks. */
export interface RunPayload {
  label?: string
  startedAt: number
  endedAt: number
  env: Record<string, unknown>
  timeOrigin: number
  nowMs: number
  sessions: { slot: number; streamId: string; delivery: string; summary: Summary }[]
  events: TelemetryEvent[]
}
