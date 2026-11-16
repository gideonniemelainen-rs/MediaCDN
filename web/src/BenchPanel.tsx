import { useState } from 'react'

// Shape written by tools/bench.mjs (bench/report.json).
interface Stat { n: number; p50: number; p95: number; p99: number; mean: number }
interface TargetResult {
  requests: number
  errors: number
  bytes: number
  ttfbMs: Stat
  segmentMs: Stat
  segmentMbps: number
  hitRatio: number | null
}
interface Scenario {
  label: string
  viewsPerMonth: number
  gbPerMonth: number
  direct: number
  cdn: number
  delta: number
}
export interface BenchReport {
  generatedAt: string
  config: { slug: string; rung: string; segments: number; rounds: number; targets: { name: string; base: string }[] }
  results: Record<string, TargetResult>
  cost: {
    assumptions: { hitRatio: number; hitRatioSource: string; note: string }
    scenarios: Scenario[]
    breakEvenGbPerMonth: number | null
    ratesNote: string
  }
}

const f = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(d))
const usd = (v: number) => `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`

function isReport(x: unknown): x is BenchReport {
  const r = x as BenchReport | null
  return !!r && typeof r === 'object' && !!r.results && !!r.config && !!r.cost
}

export function BenchPanel() {
  const [report, setReport] = useState<BenchReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onFile(file: File | undefined) {
    if (!file) return
    try {
      const json: unknown = JSON.parse(await file.text())
      if (!isReport(json)) throw new Error('not a bench report (expected results, config and cost)')
      setReport(json)
      setError(null)
    } catch (e) {
      setReport(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const names = report ? Object.keys(report.results) : []
  return (
    <div className="panel">
      <div className="panel-bar">
        <strong>Delivery benchmark</strong>
        <label>
          load report <input type="file" accept="application/json,.json" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
        {report && (
          <span>
            {report.config.slug} / {report.config.rung}, {report.config.rounds} rounds x {report.config.segments} segments,{' '}
            {new Date(report.generatedAt).toLocaleString()}
          </span>
        )}
        {error && <span className="error">{error}</span>}
      </div>
      {!report && !error && <p>Run <code>node tools/bench.mjs --target name=baseUrl ...</code>, then load <code>bench/report.json</code>.</p>}
      {report && (
        <>
          <table>
            <thead>
              <tr>
                <th>target</th><th>reqs</th><th>err</th><th>ttfb p50</th><th>p95</th><th>p99</th>
                <th>segment p50 ms</th><th>p95</th><th>Mbps</th><th>hit %</th>
              </tr>
            </thead>
            <tbody>
              {names.map((n) => {
                const r = report.results[n]
                return (
                  <tr key={n}>
                    <td>{n}</td><td>{r.requests}</td><td>{r.errors}</td>
                    <td>{f(r.ttfbMs.p50)}</td><td>{f(r.ttfbMs.p95)}</td><td>{f(r.ttfbMs.p99)}</td>
                    <td>{f(r.segmentMs.p50)}</td><td>{f(r.segmentMs.p95)}</td>
                    <td>{f(r.segmentMbps, 0)}</td><td>{r.hitRatio === null ? '-' : f(r.hitRatio * 100, 0)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <table>
            <thead>
              <tr><th>scenario</th><th>views/month</th><th>GB/month</th><th>S3 direct</th><th>via CDN</th><th>CDN minus direct</th></tr>
            </thead>
            <tbody>
              {report.cost.scenarios.map((s) => (
                <tr key={s.label}>
                  <td>{s.label}</td><td>{s.viewsPerMonth.toLocaleString()}</td><td>{f(s.gbPerMonth, 2)}</td>
                  <td>{usd(s.direct)}</td><td>{usd(s.cdn)}</td><td>{s.delta > 0 ? '+' : '-'}{usd(Math.abs(s.delta))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Cache hit ratio {f(report.cost.assumptions.hitRatio * 100, 0)}% ({report.cost.assumptions.hitRatioSource}).{' '}
            {report.cost.breakEvenGbPerMonth === null
              ? 'The CDN does not become cheaper at any volume with these rates.'
              : `The CDN becomes cheaper at about ${f(report.cost.breakEvenGbPerMonth, 0)} GB/month.`}{' '}
            {report.cost.assumptions.note}. {report.cost.ratesNote}
          </p>
        </>
      )}
    </div>
  )
}
