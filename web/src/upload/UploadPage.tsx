import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchHealth, fetchJobs, fetchStages, uploadFile } from './api'
import { draftStages } from './draft'
import { activeStageId, formatBytes } from './format'
import { useJob, useNow } from './hooks'
import { ResultPlayer } from './ResultPlayer'
import { StageDetails } from './StageDetails'
import type { JobSummary, PublishResult, Stage, StageDef } from './types'
import { WorkflowGraph } from './WorkflowGraph'
import NavBar from '../NavBar'
import './upload.css'

interface Uploading { name: string; startedAt: number; loaded: number; total: number }

const ACCEPT = 'video/*,.mov,.mp4,.m4v,.mkv,.webm,.avi'

export default function UploadPage() {
  const [health, setHealth] = useState<'checking' | 'up' | 'down'>('checking')
  const [defs, setDefs] = useState<StageDef[]>([])
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [jobId, setJobId] = useState<string | null>(null)
  const [uploading, setUploading] = useState<Uploading | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const abort = useRef<(() => void) | null>(null)

  const { job, live } = useJob(jobId)
  const refreshJobs = useCallback(() => void fetchJobs().then(setJobs, () => {}), [])

  const connect = useCallback(async () => {
    setHealth('checking')
    const up = await fetchHealth()
    setHealth(up ? 'up' : 'down')
    if (!up) return
    fetchStages().then(setDefs, () => setHealth('down'))
    refreshJobs()
  }, [refreshJobs])

  useEffect(() => {
    void connect()
  }, [connect])

  // The server has taken over: stop drawing the placeholder. (Also if the stream cannot connect,
  // so the page is not stuck in "uploading".)
  const hasJob = !!job
  useEffect(() => {
    if (hasJob || (jobId && !live)) setUploading(null)
  }, [hasJob, jobId, live])

  // The list changes when a job reaches an end state.
  const jobStatus = job?.status
  useEffect(() => {
    if (jobStatus === 'success' || jobStatus === 'failed') refreshJobs()
  }, [jobStatus, refreshJobs])

  const stages: Stage[] = useMemo(() => {
    if (job) return job.stages
    return uploading ? draftStages(defs, uploading) : []
  }, [job, uploading, defs])

  const working = !!uploading || job?.status === 'running' || job?.status === 'queued'
  const now = useNow(working)
  const shown = selected ?? activeStageId(stages)
  const stage = stages.find((s) => s.id === shown)
  const published = job?.stages.find((s) => s.id === 'publish' && s.status === 'success')?.result as PublishResult | null | undefined

  async function start(file: File | undefined) {
    if (!file || uploading) return
    setError(null)
    setSelected(null)
    setJobId(null)
    const startedAt = Date.now()
    setUploading({ name: file.name, startedAt, loaded: 0, total: file.size })
    const up = uploadFile(file, (loaded, total) => setUploading({ name: file.name, startedAt, loaded, total }))
    abort.current = up.abort
    try {
      const { id } = await up.promise
      // `uploading` stays set until the job's first snapshot arrives (see the effect above), so
      // the graph does not blink out in between.
      setJobId(id)
      refreshJobs()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setUploading(null)
    } finally {
      abort.current = null
    }
  }

  function open(id: string) {
    if (uploading) return
    setSelected(null)
    setJobId(id)
  }

  const statusText = uploading
    ? `Uploading ${uploading.name}, ${Math.round((uploading.loaded / Math.max(1, uploading.total)) * 100)}%`
    : job
      ? `${job.meta.name}: ${job.status}`
      : ''

  return (
    <div className="upload-page">
      <NavBar current="upload" />
      <header className="bar">
        <span className={`health ${health}`}>
          {health === 'checking' && 'connecting to pipeline…'}
          {health === 'up' && 'pipeline connected'}
          {health === 'down' && 'pipeline not reachable'}
        </span>
      </header>

      <main className="up-main">
        {health === 'down' && (
          <section className="detail">
            <p className="note bad">The pipeline server isn't running.</p>
            <p>
              Start it with <code>node pipeline/bin/serve.mjs</code> (and <code>node tools/serve-origin.mjs</code> to play results), then retry.
            </p>
            <button type="button" onClick={() => void connect()}>Retry</button>
          </section>
        )}

        <label
          className={`drop${dragging ? ' over' : ''}${uploading ? ' busy' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            void start(e.dataTransfer.files[0])
          }}
        >
          <input
            type="file"
            accept={ACCEPT}
            disabled={health !== 'up' || !!uploading}
            onChange={(e) => {
              void start(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <strong>{uploading ? `Uploading ${uploading.name}…` : 'Choose a video, or drop one here'}</strong>
          <span className="muted">
            {uploading ? `${formatBytes(uploading.loaded)} of ${formatBytes(uploading.total)}` : 'QuickTime .mov, MP4, MKV or WebM. Screen recordings work well.'}
          </span>
        </label>
        {uploading && <button type="button" onClick={() => abort.current?.()}>Cancel upload</button>}
        {error && <p className="note bad" role="alert">{error}</p>}

        <div role="status" aria-live="polite" className="sr-only">{statusText}</div>

        {stages.length > 0 && (
          <>
            <div className="job-head">
              <strong>{uploading?.name ?? job?.meta.name}</strong>
              {job && <span className={`chip ${job.status}`}>{job.status}</span>}
              {job && !live && <span className="muted">reconnecting…</span>}
              {selected !== null && <button type="button" onClick={() => setSelected(null)}>Follow progress</button>}
            </div>
            <WorkflowGraph stages={stages} selected={shown} onSelect={setSelected} now={now} />
            {stage && <StageDetails stage={stage} now={now} />}
            {published && <ResultPlayer id={published.id} />}
          </>
        )}

        {jobs.length > 0 && (
          <section className="detail" aria-label="Recent uploads">
            <h2>Recent uploads</h2>
            <ul className="jobs">
              {jobs.map((j) => (
                <li key={j.id}>
                  <button type="button" className={j.id === jobId ? 'current' : ''} onClick={() => open(j.id)}>
                    <span className={`dot ${j.status}`} aria-hidden="true" />
                    <span className="name">{j.name}</span>
                    <span className="muted">{formatBytes(j.bytes)}</span>
                    <span className={`chip ${j.status}`}>{j.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  )
}
