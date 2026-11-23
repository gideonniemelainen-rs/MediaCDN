import { useMemo } from 'react'
import { DELIVERY_LABEL, type Delivery } from '../catalog'
import { LineChart, type ChartSeries } from './LineChart'
import { buildSeries, capMismatch } from './series'
import type { EventsBlob } from './types'

const label = (slot: number, delivery: string) => `Q${slot + 1} · ${DELIVERY_LABEL[delivery as Delivery] ?? delivery}`

/** The time-series charts of a saved run, rebuilt from its stored events. */
export function RunCharts({ blob }: { blob: EventsBlob }) {
  const series = useMemo(() => buildSeries(blob), [blob])
  if (!series.length) return null
  const duration = Math.max(...series.map((s) => s.duration))
  const whole = (v: number) => Math.round(v).toLocaleString()
  const by = (pick: (s: (typeof series)[number]) => ChartSeries['points'], mode: ChartSeries['mode']): ChartSeries[] =>
    series.map((s) => ({ slot: s.slot, label: label(s.slot, s.delivery), points: pick(s), mode }))
  const capped = capMismatch(series)

  return (
    <div className="charts">
      {capped.length > 0 && (
        <p className="chart-warn" role="note">
          {capped.map((s) => `Q${s.slot + 1}`).join(', ')} {capped.length > 1 ? 'were' : 'was'} limited to {[...new Set(capped.map((s) => `${s.maxHeight}p`))].join(' / ')} (an unfocused quadrant), and the others were not.
          Bitrate is not comparable between them.
        </p>
      )}
      <LineChart title="Video bitrate" unit="kbps" series={by((s) => s.bitrate, 'step')} duration={duration} format={whole} />
      <LineChart
        title="Buffer ahead of the playhead"
        unit="seconds"
        series={by((s) => s.buffer, 'nearest')}
        duration={duration}
        format={(v) => v.toFixed(1)}
        markers={series.flatMap((s) => s.rebuffers.map((t) => ({ slot: s.slot, t })))}
        markerLabel="Rebuffer"
      />
      <LineChart title="Segment download time" unit="ms" series={by((s) => s.latency, 'nearest')} duration={duration} format={whole} />
    </div>
  )
}
