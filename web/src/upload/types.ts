// Shapes of the pipeline server's job snapshots (pipeline/src/stages.mjs, pipeline/src/steps.mjs).

export type StageStatus = 'queued' | 'running' | 'success' | 'failed' | 'skipped' | 'cached'
export type JobStatus = 'queued' | 'running' | 'success' | 'failed'

export interface Stage {
  id: string
  label: string
  needs: string[]
  status: StageStatus
  startedAt: number | null
  endedAt: number | null
  /** 0..1 while running, null when the stage reports none. */
  progress: number | null
  summary: string | null
  result: Record<string, unknown> | null
  log: string[]
}

export interface StageDef {
  id: string
  label: string
  needs: string[]
}

export interface Job {
  id: string
  status: JobStatus
  createdAt: number
  meta: { uploadId: string; name: string; bytes: number; sha256: string; outputId: string }
  stages: Stage[]
}

export interface JobSummary {
  id: string
  name: string
  status: JobStatus
  createdAt: number
  outputId: string
  bytes: number
}

// Per-stage `result` payloads, cast where each stage's details are shown.
export interface Warning { code: string; detail?: string }
export interface ValidationError { code: string; message?: string; detail?: string }
export interface ProbeResult {
  info: {
    container: string
    duration: number
    bytes: number
    video: null | {
      codec: string; width: number; height: number; displayWidth: number; displayHeight: number
      rotation: number; rFps: number; avgFps: number; vfr: boolean; pixFmt: string; bitDepth: number; hdr: boolean; interlaced: boolean
    }
    audio: { codec: string; channels: number; sampleRate: number }[]
  }
}
export interface ValidateResult { warnings: Warning[]; errors: ValidationError[]; code?: string }
export interface NormaliseResult {
  key: string
  mezzanineBytes: number
  decisions: { fps: number; sourceFps: number; rotated: number; deinterlaced: boolean; tonemapped: boolean; squarePixels: boolean; audio: { synthesised?: boolean; track?: number; tracks?: number }; loudnorm: string }
}
/** The ladder stage: `fixed` ladders come from the fixed table, the rest were measured (`measured` is the average kbps at constant quality `crf`). */
export interface LadderResult {
  rungs: { height: number; kbps: number }[]
  fixed: boolean
  reason?: string | null
  class?: 'screen' | 'film'
  bpp?: number
  crf?: number
  measured?: { height: number; kbps: number }[]
  dropped?: { height: number; reason: string }[]
  sampledSeconds?: number
}
/** `packager` is absent on jobs packaged before it was recorded (those used ffmpeg). */
export interface PackageResult { rungs: { height: number; kbps: number }[]; bytes: number; packager?: 'ffmpeg' | 'shaka' }
export interface VerifyResult { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[]; renditions: { bandwidth: number; resolution: string | null }[] }
export interface PublishResult { id: string; path: string; urls: { hls: string; dash: string } }
export interface UploadResult { name: string; bytes: number; sha256: string; mbPerSecond: number }
