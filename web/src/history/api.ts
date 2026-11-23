import { sessionEnded } from '../auth/store'
import type { EventsBlob, RunDetail, RunPage, RunPayload, UploadPage } from './types'

const BASE = '/api/pipeline'

export async function fetchUploads(before?: string | null, limit = 25): Promise<UploadPage> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (before) q.set('before', before)
  let res: Response
  try {
    res = await fetch(`${BASE}/uploads?${q}`, { cache: 'no-store' })
  } catch {
    throw new Error('could not reach the pipeline server')
  }
  if (res.status === 401) sessionEnded()
  if (!res.ok) throw new Error(`could not load uploads (${res.status})`)
  return (await res.json()) as UploadPage
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { cache: 'no-store', ...init })
  } catch {
    throw new Error('could not reach the pipeline server')
  }
  if (res.status === 401) sessionEnded()
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`)
  return body as T
}

export const saveRun = (payload: RunPayload) =>
  call<{ id: string }>('/benchmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })

export function fetchRuns(before?: string | null, limit = 25) {
  const q = new URLSearchParams({ limit: String(limit) })
  if (before) q.set('before', before)
  return call<RunPage>(`/benchmarks?${q}`)
}

export const fetchRun = (id: string) => call<RunDetail>(`/benchmarks/${encodeURIComponent(id)}`)
export const fetchRunEvents = (id: string) => call<EventsBlob>(`/benchmarks/${encodeURIComponent(id)}/artifacts/telemetry-events`)
export const deleteRun = (id: string) => call<{ ok: true }>(`/benchmarks/${encodeURIComponent(id)}`, { method: 'DELETE' })
