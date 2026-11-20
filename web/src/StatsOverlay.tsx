import { DELIVERY_LABEL, type Delivery } from './catalog'
import { summarize } from './telemetry/metrics'
import { telemetry } from './telemetry/store'
import { useTelemetryVersion } from './telemetry/useTelemetry'

const fmt = (v: number | null, digits = 0, unit = '') => (v === null ? '-' : v.toFixed(digits) + unit)

export function StatsOverlay({ slot, delivery }: { slot: number; delivery: Delivery }) {
  useTelemetryVersion()
  const events = telemetry.getEvents()
  const s = summarize(events, slot, performance.now())
  if (!s) return null
  const last = [...events].reverse().find((e) => e.slot === slot && e.type === 'sample')
  return (
    <pre className="stats">
      {`${DELIVERY_LABEL[delivery]}
startup ${fmt(s.startupMs, 0, ' ms')}
bitrate ${fmt(s.avgBitrateKbps, 0, ' kbps')} avg, ${last ? `${last.data.height ?? '?'}p` : '-'}
buffer ${fmt((last?.data.bufferedAhead as number | undefined) ?? null, 1, ' s')}
rebuffer ${s.rebufferCount}x ${fmt(s.rebufferMs / 1000, 1, ' s')} (${fmt(s.rebufferRatio * 100, 1, '%')})
switches ${s.switches}  errors ${s.errors}
segs ${s.requests} req, ${fmt(s.meanSegmentLatencyMs, 0, ' ms')}, ${fmt(s.throughputKbps, 0, ' kbps')}${
        s.liveLatencyS !== null ? `\nlive latency ${fmt(s.liveLatencyS, 1, ' s')}` : ''
      }`}
    </pre>
  )
}
