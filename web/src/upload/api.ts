// Client for the pipeline server (pipeline/bin/serve.mjs), reached through the Vite proxy.
import { sessionEnded } from '../auth/store'
import type { Job, JobSummary, StageDef } from './types'

const BASE = '/api/pipeline'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' })
  if (res.status === 401) sessionEnded()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const fetchHealth = () =>
  getJson<{ ok: boolean }>('/health').then(
    (r) => r.ok,
    () => false,
  )
export const fetchStages = () => getJson<{ stages: StageDef[] }>('/stages').then((r) => r.stages)
export const fetchJobs = () => getJson<{ jobs: JobSummary[] }>('/jobs').then((r) => r.jobs)

/**
 * Uploads the file as a raw body (not multipart, so the server can stream it to disk). XHR rather
 * than fetch because fetch has no upload progress.
 */
export function uploadFile(file: File, onProgress: (loaded: number, total: number) => void) {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<{ id: string }>((resolve, reject) => {
    xhr.open('POST', `${BASE}/uploads`)
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name))
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total)
    xhr.onload = () => {
      let body: { id?: string; error?: string } = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch {}
      if (xhr.status === 401) sessionEnded()
      if (xhr.status === 202 && body.id) resolve({ id: body.id })
      else reject(new Error(body.error ?? `upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('could not reach the pipeline server'))
    xhr.onabort = () => reject(new Error('upload cancelled'))
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}

/**
 * Follows a job over server-sent events. The server sends the current snapshot first, so a reload
 * or a reconnect recovers state. Returns a function that stops watching.
 */
export function watchJob(id: string, onSnapshot: (job: Job) => void, onConnection: (live: boolean) => void): () => void {
  const es = new EventSource(`${BASE}/jobs/${id}/events`)
  es.onopen = () => onConnection(true)
  es.onerror = () => onConnection(false)
  es.onmessage = (e) => {
    onConnection(true)
    onSnapshot(JSON.parse(e.data) as Job)
  }
  // The job finished: stop, or the browser would reconnect and replay it forever.
  es.addEventListener('done', () => es.close())
  return () => es.close()
}
