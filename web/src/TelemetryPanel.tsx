import { SLOT_COUNT } from './state'
import { toCSV, toJSON, summarize } from './telemetry/metrics'
import { type CompareRow, bestSlots } from './telemetry/compare'
import { telemetry } from './telemetry/store'
import { useTelemetryVersion } from './telemetry/useTelemetry'

function download(name: string, text: string, type: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

const f = (v: number | null, d = 0) => (v === null ? '-' : v.toFixed(d))

export function TelemetryPanel() {
  useTelemetryVersion()
  const events = telemetry.getEvents()
  const now = performance.now()
  const rows = Array.from({ length: SLOT_COUNT }, (_, slot) => {
    const summary = summarize(events, slot, now)
    const first = [...events].reverse().find((e) => e.slot === slot && e.type === 'load-start')
    return { slot, summary, first }
  })
  // When the same stream plays in several quadrants, mark who is ahead on each metric.
  const best = bestSlots(rows.flatMap((r): CompareRow[] => (r.summary ? [{ slot: r.slot, streamId: r.first?.streamId, summary: r.summary }] : [])))
  const win = (key: keyof typeof best, slot: number) => (best[key].has(slot) ? 'best' : undefined)
  return (
    <div className="panel">
      <div className="panel-bar">
        <strong>Telemetry</strong>
        <button onClick={() => download('telemetry.json', toJSON(events), 'application/json')}>JSON</button>
        <button onClick={() => download('telemetry.csv', toCSV(events), 'text/csv')}>CSV</button>
        <button onClick={() => telemetry.clear()}>Clear</button>
        <span>{events.length} events</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>slot</th><th>stream</th><th>delivery</th><th>startup ms</th><th>kbps avg</th>
            <th>rebuf</th><th>rebuf %</th><th>switches</th><th>seg ms</th><th>kbps net</th><th>err</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ slot, summary: s, first }) => {
            return s ? (
              <tr key={slot}>
                <td>{slot + 1}</td><td>{first?.streamId}</td><td>{first?.delivery}</td>
                <td className={win('startupMs', slot)}>{f(s.startupMs)}</td>
                <td className={win('avgBitrateKbps', slot)}>{f(s.avgBitrateKbps)}</td>
                <td className={win('rebufferCount', slot)}>{s.rebufferCount}</td>
                <td className={win('rebufferRatio', slot)}>{f(s.rebufferRatio * 100, 1)}</td><td>{s.switches}</td>
                <td className={win('meanSegmentLatencyMs', slot)}>{f(s.meanSegmentLatencyMs)}</td>
                <td className={win('throughputKbps', slot)}>{f(s.throughputKbps)}</td>
                <td className={win('errors', slot)}>{s.errors}</td>
              </tr>
            ) : (
              <tr key={slot}><td>{slot + 1}</td><td colSpan={10}>idle</td></tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
