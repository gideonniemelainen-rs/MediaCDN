import { useState } from 'react'
import shaka from 'shaka-player'
import { useAuth } from './auth/useAuth'
import { saveRun } from './history/api'
import { buildRunPayload } from './history/run'
import { SLOT_COUNT } from './state'
import { capOf, toCSV, toJSON, summarize } from './telemetry/metrics'
import { SummaryTable } from './telemetry/SummaryTable'
import { TransportTable } from './telemetry/TransportTable'
import { telemetry } from './telemetry/store'
import { useTelemetryVersion } from './telemetry/useTelemetry'

function download(name: string, text: string, type: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

type Saved = { state: 'idle' } | { state: 'saving' } | { state: 'saved' } | { state: 'error'; message: string }

export function TelemetryPanel() {
  useTelemetryVersion()
  const auth = useAuth()
  const [label, setLabel] = useState('')
  const [saved, setSaved] = useState<Saved>({ state: 'idle' })
  const events = telemetry.getEvents()
  const now = performance.now()
  const rows = Array.from({ length: SLOT_COUNT }, (_, slot) => {
    const summary = summarize(events, slot, now)
    const first = [...events].reverse().find((e) => e.slot === slot && e.type === 'load-start')
    return { slot, summary, streamId: first?.streamId, delivery: first?.delivery, maxHeight: capOf(events, slot) }
  })
  const hasRun = rows.some((r) => r.summary)

  async function save() {
    const payload = buildRunPayload({
      events: telemetry.getEvents(),
      now: performance.now(),
      timeOrigin: performance.timeOrigin,
      label,
      env: { userAgent: navigator.userAgent, shaka: shaka.Player.version },
    })
    if (!payload) return
    setSaved({ state: 'saving' })
    try {
      await saveRun(payload)
      setSaved({ state: 'saved' })
      setLabel('')
    } catch (e) {
      setSaved({ state: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="panel">
      <div className="panel-bar">
        <strong>Telemetry</strong>
        <button onClick={() => download('telemetry.json', toJSON(events), 'application/json')}>JSON</button>
        <button onClick={() => download('telemetry.csv', toCSV(events), 'text/csv')}>CSV</button>
        <button onClick={() => telemetry.clear()}>Clear</button>
        <span>{events.length} events</span>
        <span className="panel-save">
          {auth.status === 'signedIn' ? (
            <>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="label (optional)"
                aria-label="Run label"
                maxLength={120}
              />
              <button onClick={() => void save()} disabled={!hasRun || saved.state === 'saving'}>
                {saved.state === 'saving' ? 'Saving…' : 'Save run'}
              </button>
            </>
          ) : (
            <a href="/analysis/">Sign in to save runs</a>
          )}
          {saved.state === 'saved' && <span role="status">Saved. <a href="/analysis/">View in Analysis</a></span>}
          {saved.state === 'error' && <span className="error" role="alert">{saved.message}</span>}
        </span>
      </div>
      <SummaryTable rows={rows} />
      <TransportTable rows={rows} />
    </div>
  )
}
