import { useEffect, useState } from 'react'
import { watchJob } from './api'
import type { Job } from './types'

/** The live snapshot of one job, plus whether the event stream is currently connected. */
export function useJob(id: string | null) {
  // Keyed by id so switching jobs never shows the previous job's snapshot for a render.
  const [state, setState] = useState<{ id: string | null; job: Job | null }>({ id: null, job: null })
  const [live, setLive] = useState(true)
  useEffect(() => {
    if (!id) return
    return watchJob(id, (job) => setState({ id, job }), setLive)
  }, [id])
  return { job: state.id === id ? state.job : null, live }
}

/** A clock that ticks while `active`, so running stages show a live elapsed time. */
export function useNow(active: boolean, everyMs = 500) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [active, everyMs])
  return now
}
