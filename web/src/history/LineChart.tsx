// A line chart in plain SVG: one line per quadrant on a shared axis, a legend, a crosshair with a single tooltip
// listing every series, keyboard reading with the arrow keys, and a table twin. Colour is by quadrant slot
// (--series-1..4, see index.css), never by rank.
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { extendTo, formatCompact, formatSeconds, niceMax, niceTicks, snapTime, tableRows, valueAt } from './chart-math'
import type { Point } from './series'
import { useElementWidth } from './useElementWidth'

export interface ChartSeries {
  slot: number
  label: string
  points: Point[]
  /** 'step' holds a value until it changes (a setting); 'nearest' is a measurement taken at a moment. */
  mode: 'step' | 'nearest'
}

export interface ChartMarker {
  slot: number
  t: number
}

interface Props {
  title: string
  unit: string
  series: ChartSeries[]
  /** Seconds the x axis spans. */
  duration: number
  format?: (v: number) => string
  /** Events drawn on the baseline, such as rebuffers. */
  markers?: ChartMarker[]
  markerLabel?: string
}

const HEIGHT = 220
const M = { l: 48, r: 68, t: 12, b: 28 }
const seriesColor = (slot: number) => `var(--series-${(slot % 4) + 1})`

export function LineChart({ title, unit, series, duration, format = formatCompact, markers = [], markerLabel }: Props) {
  const [frame, width] = useElementWidth<HTMLDivElement>()
  const [cursor, setCursor] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)
  const id = useId()

  const plotW = Math.max(0, width - M.l - M.r)
  const plotH = HEIGHT - M.t - M.b
  const span = Math.max(duration, 1)
  const yMax = niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v))))
  const x = (t: number) => M.l + (t / span) * plotW
  const y = (v: number) => M.t + plotH - (v / yMax) * plotH
  const hasData = series.some((s) => s.points.length > 0)

  // What the crosshair snaps to and the arrow keys step through: the moments something was measured. A setting
  // that holds until it changes (a step series) has one point per change, so on a chart of only those the
  // crosshair moves freely, one second per key press.
  const measured = useMemo(() => series.filter((s) => s.mode === 'nearest'), [series])
  const times = useMemo(() => {
    if (measured.length) return [...new Set(measured.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b)
    return Array.from({ length: Math.floor(duration) + 1 }, (_, i) => i)
  }, [measured, duration])
  const rows = useMemo(() => tableRows(series, duration, 1), [series, duration])

  const path = (s: ChartSeries) => {
    const pts = s.mode === 'step' ? extendTo(s.points, duration) : s.points
    return pts
      .map((p, i) => {
        if (i === 0) return `M${x(p.t)},${y(p.v)}`
        return s.mode === 'step' ? `H${x(p.t)}V${y(p.v)}` : `L${x(p.t)},${y(p.v)}`
      })
      .join('')
  }

  function move(e: PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect()
    const t = Math.min(span, Math.max(0, ((e.clientX - box.left) / Math.max(1, box.width)) * span))
    setCursor(measured.length ? (snapTime(measured.map((s) => s.points), t) ?? t) : t)
  }

  function key(e: KeyboardEvent<HTMLDivElement>) {
    if (!times.length || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    e.preventDefault()
    const at = cursor ?? (e.key === 'ArrowRight' ? -1 : span + 1)
    const next = e.key === 'ArrowRight' ? times.find((t) => t > at + 1e-9) : [...times].reverse().find((t) => t < at - 1e-9)
    if (next !== undefined) setCursor(next)
  }

  const readout = cursor === null ? [] : series.map((s) => ({ s, v: valueAt(s.points, cursor, s.mode) }))
  const cx = cursor === null ? 0 : x(cursor)
  const flip = cx > M.l + plotW / 2

  // End labels sit at the right end of each line. Lines that end together (often identical lines, drawn on top of
  // each other) share one label, "Q2 Q3", rather than one label naming only the line that is on top.
  const ends = [...series]
    .filter((s) => s.points.length)
    .map((s) => ({ slot: s.slot, py: y((s.mode === 'step' ? extendTo(s.points, duration) : s.points).at(-1)!.v) }))
    .sort((a, b) => a.py - b.py)
    .reduce<{ py: number; slots: number[] }[]>((groups, e) => {
      const last = groups[groups.length - 1]
      if (last && e.py - last.py < 13) return [...groups.slice(0, -1), { py: last.py, slots: [...last.slots, e.slot] }]
      return [...groups, { py: e.py, slots: [e.slot] }]
    }, [])

  return (
    <figure className="chart" aria-labelledby={`${id}-t`}>
      <figcaption>
        <h3 id={`${id}-t`}>{title}</h3>
        <span className="chart-unit">{unit}</span>
        <button type="button" className="chart-toggle" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Chart' : 'Table'}
        </button>
      </figcaption>

      {series.length > 1 && (
        <ul className="chart-legend">
          {series.map((s) => (
            <li key={s.slot}>
              <span className="key" style={{ background: seriesColor(s.slot) }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
          {markers.length > 0 && markerLabel && (
            <li>
              <span className="dot" aria-hidden="true" />
              {markerLabel}
            </li>
          )}
        </ul>
      )}
      {series.length === 1 && <p className="chart-sub">{series[0].label}</p>}

      {!hasData && <p className="muted chart-empty">No data in this run.</p>}

      {hasData && asTable && (
        <div className="chart-table-wrap">
          <table className="chart-table">
            <thead>
              <tr>
                <th>Time</th>
                {series.map((s) => (
                  <th key={s.slot}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.t}>
                  <td>{formatSeconds(r.t)}</td>
                  {r.values.map((v, i) => (
                    <td key={series[i].slot}>{v === null ? '–' : format(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {markers.length > 0 && markerLabel && (
            <p className="muted">
              {markerLabel}: {markers.map((m) => `${series.find((s) => s.slot === m.slot)?.label.split(' · ')[0] ?? `Q${m.slot + 1}`} at ${formatSeconds(m.t)}`).join(', ')}
            </p>
          )}
        </div>
      )}

      {hasData && !asTable && (
        <div
          ref={frame}
          className="chart-frame"
          tabIndex={0}
          role="group"
          aria-label={`${title}. Use the left and right arrow keys to read values; the Table button lists them all.`}
          onKeyDown={key}
          onBlur={() => setCursor(null)}
        >
          {width > 0 && (
            <svg width={width} height={HEIGHT} role="presentation">
              {niceTicks(0, yMax, 4).map((v) => (
                <g key={v}>
                  <line className="grid" x1={M.l} x2={M.l + plotW} y1={y(v)} y2={y(v)} />
                  <text className="tick" x={M.l - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">{formatCompact(v)}</text>
                </g>
              ))}
              {niceTicks(0, span, Math.max(2, Math.floor(plotW / 90))).map((t) => (
                <text key={t} className="tick" x={x(t)} y={HEIGHT - 8} textAnchor="middle">{formatSeconds(t)}</text>
              ))}
              <line className="axis" x1={M.l} x2={M.l + plotW} y1={y(0)} y2={y(0)} />

              {series.map((s) => (
                <path key={s.slot} className="line" d={path(s)} style={{ stroke: seriesColor(s.slot) }} />
              ))}
              {series.filter((s) => s.mode === 'nearest' && s.points.length === 1).map((s) => (
                <circle key={s.slot} className="mark" cx={x(s.points[0].t)} cy={y(s.points[0].v)} r={4} style={{ fill: seriesColor(s.slot) }} />
              ))}
              {markers.map((m, i) => (
                <circle key={i} className="mark" cx={x(m.t)} cy={y(0)} r={4} style={{ fill: seriesColor(m.slot) }} />
              ))}
              {ends.map(({ py, slots }) => (
                <text key={slots.join()} className="end-label" x={M.l + plotW + 6} y={py} dominantBaseline="middle">
                  {slots.map((slot) => `Q${slot + 1}`).join(' ')}
                </text>
              ))}

              {cursor !== null && (
                <g>
                  <line className="crosshair" x1={cx} x2={cx} y1={M.t} y2={M.t + plotH} />
                  {readout.map(({ s, v }) => v !== null && <circle key={s.slot} className="mark" cx={cx} cy={y(v)} r={4} style={{ fill: seriesColor(s.slot) }} />)}
                </g>
              )}
              <rect x={M.l} y={M.t} width={plotW} height={plotH} fill="transparent" onPointerMove={move} onPointerLeave={() => setCursor(null)} />
            </svg>
          )}
          {cursor !== null && (
            <div className="chart-tip" style={flip ? { right: width - cx + 12, top: M.t } : { left: cx + 12, top: M.t }} role="status">
              <div className="tip-time">{formatSeconds(cursor)}</div>
              {readout.map(({ s, v }) => (
                <div key={s.slot} className="tip-row">
                  <span className="key" style={{ background: seriesColor(s.slot) }} aria-hidden="true" />
                  <strong>{v === null ? '–' : format(v)}</strong>
                  <span className="tip-name">{s.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  )
}
