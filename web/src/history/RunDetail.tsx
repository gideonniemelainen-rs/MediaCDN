import { useEffect, useState } from 'react'
import { DELIVERY_LABEL, type Delivery } from '../catalog'
import { SummaryTable } from '../telemetry/SummaryTable'
import { fetchRunEvents } from './api'
import { rebuildRows, type RebuiltRow } from './run'
import { RunCharts } from './RunCharts'
import type { EventsBlob, RunRow } from './types'

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; blob: EventsBlob; rows: RebuiltRow[] }

/** A saved run's comparison, rebuilt from its stored telemetry rather than from stored totals. */
export function RunDetail({ run }: { run: RunRow }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  useEffect(() => {
    let cancelled = false
    fetchRunEvents(run.id).then(
      (blob) => !cancelled && setLoad({ state: 'ready', blob, rows: rebuildRows(blob) }),
      (e) => !cancelled && setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      cancelled = true
    }
  }, [run.id])

  if (load.state === 'loading') return <p className="muted">Loading…</p>
  if (load.state === 'error') return <p className="auth-error" role="alert">{load.message}</p>
  const thinned = load.blob.downsampled?.sampleEvents
  return (
    <div className="run-detail">
      <div className="panel run-panel">
        <SummaryTable
          rows={load.rows.map((r) => ({ ...r, delivery: DELIVERY_LABEL[r.delivery as Delivery] ?? r.delivery }))}
        />
      </div>
      <RunCharts blob={load.blob} />
      <p className="muted">
        {load.blob.events.length.toLocaleString()} events
        {thinned && ` (periodic samples thinned from ${thinned.from.toLocaleString()} to ${thinned.to.toLocaleString()} to fit)`}
        {typeof run.env.userAgent === 'string' && ` · ${run.env.userAgent}`}
        {typeof run.env.shaka === 'string' && ` · Shaka ${run.env.shaka}`}
      </p>
    </div>
  )
}
