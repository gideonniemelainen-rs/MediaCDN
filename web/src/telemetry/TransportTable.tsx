import { type SummaryRowData } from './SummaryTable'
import { summarizeByTransport } from './metrics'

const f = (v: number | null, d = 0) => (v === null ? '-' : v.toFixed(d))

/**
 * The same quadrants grouped by delivery and the protocol actually observed. Shown once at least two
 * groups exist, because one group is just the table above it.
 */
export function TransportTable({ rows }: { rows: readonly SummaryRowData[] }) {
  const groups = summarizeByTransport(rows)
  if (groups.length < 2) return null
  return (
    <table aria-label="By transport">
      <thead>
        <tr>
          <th>delivery</th><th>origin</th><th>proto</th><th>quads</th><th>startup ms</th><th>rebuf %</th>
          <th>seg ms</th><th>kbps net</th><th>ttfb ms</th><th>connect ms</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <tr key={`${g.delivery}|${g.origin}|${g.transport}`}>
            <td>{g.delivery}</td><td>{g.origin}</td><td>{g.transport}</td><td>{g.quadrants}</td>
            <td>{f(g.startupMs)}</td><td>{f(g.rebufferRatio === null ? null : g.rebufferRatio * 100, 1)}</td>
            <td>{f(g.meanSegmentLatencyMs)}</td><td>{f(g.throughputKbps)}</td>
            <td>{f(g.meanTtfbMs, 1)}</td><td>{f(g.meanConnectMs, 1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
