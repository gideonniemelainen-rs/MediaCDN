import { Fragment, useCallback, useEffect, useState } from 'react'
import { useAuth } from './auth/useAuth'
import { DELIVERY_LABEL, type Delivery } from './catalog'
import { deleteRun, fetchRuns, fetchUploads } from './history/api'
import { formatAge, mergeUploads, playerHref } from './history/format'
import { describeRun } from './history/run'
import { RunDetail } from './history/RunDetail'
import type { RunRow, UploadRow } from './history/types'
import NavBar from './NavBar'
import { formatBytes, formatDuration } from './upload/format'

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready' }

export default function AnalysisPage() {
  const auth = useAuth()
  const isAdmin = auth.status === 'signedIn' && auth.user.role === 'admin'
  const [rows, setRows] = useState<UploadRow[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [now] = useState(() => Date.now())

  const loadPage = useCallback(async (before: string | null) => {
    setLoad({ state: 'loading' })
    try {
      const page = await fetchUploads(before)
      setRows((shown) => (before ? mergeUploads(shown, page.uploads) : page.uploads))
      setNext(page.next)
      setLoad({ state: 'ready' })
    } catch (e) {
      setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => {
    void loadPage(null)
  }, [loadPage])

  const [runs, setRuns] = useState<RunRow[]>([])
  const [runsNext, setRunsNext] = useState<string | null>(null)
  const [runsLoad, setRunsLoad] = useState<Load>({ state: 'loading' })
  const [open, setOpen] = useState<string | null>(null)

  const loadRuns = useCallback(async (before: string | null) => {
    setRunsLoad({ state: 'loading' })
    try {
      const page = await fetchRuns(before)
      setRuns((shown) => (before ? [...shown, ...page.runs.filter((r) => !shown.some((s) => s.id === r.id))] : page.runs))
      setRunsNext(page.next)
      setRunsLoad({ state: 'ready' })
    } catch (e) {
      setRunsLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => {
    void loadRuns(null)
  }, [loadRuns])

  async function removeRun(run: RunRow) {
    try {
      await deleteRun(run.id)
      setRuns((shown) => shown.filter((r) => r.id !== run.id))
      setOpen((id) => (id === run.id ? null : id))
    } catch (e) {
      setRunsLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }
  const deliveryLabel = (d: string) => DELIVERY_LABEL[d as Delivery] ?? d

  return (
    <div className="app">
      <NavBar current="analysis" />
      <main className="analysis">
        <h1>Analysis</h1>
        <section aria-labelledby="uploads-h">
          <h2 id="uploads-h">Uploads</h2>
          {load.state === 'error' && (
            <p className="auth-error" role="alert">
              {load.message} <button type="button" onClick={() => void loadPage(null)}>Retry</button>
            </p>
          )}
          {rows.length === 0 && load.state === 'ready' && <p className="muted">No uploads yet. Upload a video and it will be listed here.</p>}
          {rows.length > 0 && (
            <table className="history">
              <thead>
                <tr>
                  <th>When</th>
                  <th>File</th>
                  <th className="num">Size</th>
                  <th>Status</th>
                  <th className="num">Took</th>
                  {isAdmin && <th>By</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const href = playerHref(r)
                  return (
                    <tr key={r.id}>
                      <td title={new Date(r.createdAt).toLocaleString()}>{formatAge(r.createdAt, now)}</td>
                      <td className="name">{r.name}</td>
                      <td className="num">{r.bytes === null ? '' : formatBytes(r.bytes)}</td>
                      <td>
                        <span className={`pill ${r.status}`}>{r.status}</span>
                        {r.errorCode && <code className="code">{r.errorCode}</code>}
                      </td>
                      <td className="num">{r.durationMs === null ? '' : formatDuration(r.durationMs)}</td>
                      {isAdmin && <td>{r.owner}</td>}
                      <td>{href && <a href={href}>Play</a>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {load.state === 'loading' && <p className="muted">Loading…</p>}
          {next && load.state === 'ready' && (
            <button type="button" className="more" onClick={() => void loadPage(next)}>Load more</button>
          )}
        </section>
        <section aria-labelledby="runs-h">
          <h2 id="runs-h">Benchmark runs</h2>
          {runsLoad.state === 'error' && (
            <p className="auth-error" role="alert">
              {runsLoad.message} <button type="button" onClick={() => void loadRuns(null)}>Retry</button>
            </p>
          )}
          {runs.length === 0 && runsLoad.state === 'ready' && (
            <p className="muted">No saved runs yet. Play a title in the player, then use Save run in the telemetry panel.</p>
          )}
          {runs.length > 0 && (
            <table className="history">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Run</th>
                  <th>Compared</th>
                  {isAdmin && <th>By</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td title={new Date(r.startedAt).toLocaleString()}>{formatAge(r.startedAt, now)}</td>
                      <td className="name">{r.label || <span className="muted">untitled</span>}</td>
                      <td>{describeRun(r.sessions, deliveryLabel)}</td>
                      {isAdmin && <td>{r.owner}</td>}
                      <td className="actions">
                        <button type="button" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                          {open === r.id ? 'Hide' : 'Open'}
                        </button>
                        <button type="button" className="danger" onClick={() => void removeRun(r)}>Delete</button>
                      </td>
                    </tr>
                    {open === r.id && (
                      <tr className="detail-row">
                        <td colSpan={isAdmin ? 5 : 4}>
                          <RunDetail run={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
          {runsLoad.state === 'loading' && <p className="muted">Loading…</p>}
          {runsNext && runsLoad.state === 'ready' && (
            <button type="button" className="more" onClick={() => void loadRuns(runsNext)}>Load more</button>
          )}
        </section>
      </main>
    </div>
  )
}
