import { type CompareRow, bestSlots } from './compare'
import type { Summary } from './metrics'

export interface SummaryRowData {
  slot: number
  streamId?: string
  delivery?: string
  summary: Summary | null
}

const f = (v: number | null, d = 0) => (v === null ? '-' : v.toFixed(d))

/** One row per quadrant. When several play the same stream, the best value per metric is marked. */
export function SummaryTable({ rows }: { rows: readonly SummaryRowData[] }) {
  const best = bestSlots(rows.flatMap((r): CompareRow[] => (r.summary ? [{ slot: r.slot, streamId: r.streamId, summary: r.summary }] : [])))
  const win = (key: keyof typeof best, slot: number) => (best[key].has(slot) ? 'best' : undefined)
  return (
    <table>
      <thead>
        <tr>
          <th>slot</th><th>stream</th><th>delivery</th><th>startup ms</th><th>kbps avg</th>
          <th>rebuf</th><th>rebuf %</th><th>switches</th><th>seg ms</th><th>kbps net</th><th>err</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ slot, streamId, delivery, summary: s }) =>
          s ? (
            <tr key={slot}>
              <td>{slot + 1}</td><td>{streamId}</td><td>{delivery}</td>
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
          ),
        )}
      </tbody>
    </table>
  )
}
