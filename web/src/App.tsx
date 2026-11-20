import { useReducer, useState } from 'react'
import { AdOverlay } from './AdOverlay'
import { fetchAd } from './ads'
import { DELIVERIES, type Delivery, findStream, isIndexed, pickForPreset, resolveStream, streamsFor } from './catalog'
import { useCatalog } from './useCatalog'
import { QuadrantPlayer } from './QuadrantPlayer'
import { StatsOverlay } from './StatsOverlay'
import { SLOT_COUNT, initialState, isMuted, isStreamMuted, pickAdSlot, reducer } from './state'
import { readLaunch } from './launch'
import { BenchPanel } from './BenchPanel'
import { TelemetryPanel } from './TelemetryPanel'
import './index.css'

// Fixed layouts so repeated runs are comparable. Entries are title groups or 'live'; each resolves
// to whichever variant the current delivery offers, and to an empty quadrant if none.
const PRESETS: Record<string, string[]> = {
  '4x same title': ['bbb', 'bbb', 'bbb', 'bbb'],
  'mixed VOD + live': ['llamigos', 'agent-327', 'bbb', 'live'],
}

export default function App() {
  // /?delivery=local&stream=<id>-hls is how the upload page opens a published title here.
  const [launch] = useState(() => readLaunch(window.location.search))
  const [state, dispatch] = useReducer(reducer, launch, (l) =>
    l.stream ? reducer(initialState, { type: 'setStream', slot: 0, streamId: l.stream }) : initialState,
  )
  const [delivery, setDelivery] = useState<Delivery>(launch.delivery ?? 'direct')
  const [showStats, setShowStats] = useState(true)
  const [showPanel, setShowPanel] = useState(true)
  const [showBench, setShowBench] = useState(false)
  const [adMessage, setAdMessage] = useState<string | null>(null)
  const { status, reload } = useCatalog(delivery)
  const offered = streamsFor(delivery)

  // A preset entry the delivery doesn't offer (e.g. a title that isn't packaged yet) falls back to
  // whichever VOD titles are available, so presets still fill the grid; 'live' stays empty if absent.
  function applyPreset(ids: string[]) {
    const vod = offered.filter((s) => s.kind === 'VOD')
    ids.forEach((entry, slot) => {
      const pick = pickForPreset(entry, delivery) ?? (entry === 'live' ? undefined : vod[slot % Math.max(1, vod.length)])
      dispatch({ type: 'setStream', slot, streamId: pick?.id ?? null })
    })
  }

  async function triggerAd() {
    const slot = pickAdSlot(state)
    if (slot === null || state.ad) return
    setAdMessage(null)
    try {
      const ad = await fetchAd()
      dispatch({ type: 'startAd', slot, clipUrl: ad.clipUrl, label: ad.label, attribution: ad.attribution })
    } catch (e) {
      setAdMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const shown = [...new Set(state.slots)].map(findStream).filter((s) => s !== undefined)

  return (
    <div className="app">
      <header className="bar">
        <a className="nav-link" href="/upload/">Upload</a>
        <label>
          Delivery{' '}
          <select value={delivery} onChange={(e) => setDelivery(e.target.value as Delivery)}>
            {DELIVERIES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <span className="catalog-status">
          {status.state === 'loading' && 'loading titles...'}
          {status.state === 'ready' && `${offered.length} streams`}
          {status.state === 'error' && <span className="error">index: {status.message}</span>}
        </span>
        {isIndexed(delivery) && <button onClick={reload}>Reload titles</button>}
        {Object.entries(PRESETS).map(([name, ids]) => (
          <button key={name} onClick={() => applyPreset(ids)}>
            {name}
          </button>
        ))}
        <label>
          <input type="checkbox" checked={showStats} onChange={(e) => setShowStats(e.target.checked)} /> stats
        </label>
        <label>
          <input type="checkbox" checked={showPanel} onChange={(e) => setShowPanel(e.target.checked)} /> telemetry
        </label>
        <label>
          <input type="checkbox" checked={showBench} onChange={(e) => setShowBench(e.target.checked)} /> benchmark
        </label>
        <button onClick={triggerAd} disabled={!!state.ad}>
          Trigger ad
        </button>
        {adMessage && <span className="error">ad: {adMessage}</span>}
      </header>

      <div className="grid">
        {Array.from({ length: SLOT_COUNT }, (_, slot) => {
          const stream = findStream(state.slots[slot])
          return (
            <section
              key={slot}
              className={state.focused === slot ? 'quad focused' : 'quad'}
              onClick={() => dispatch({ type: 'focus', slot })}
            >
              <select
                value={state.slots[slot] ?? ''}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => dispatch({ type: 'setStream', slot, streamId: e.target.value || null })}
              >
                <option value="">(empty)</option>
                {offered.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} [{s.kind}]
                  </option>
                ))}
              </select>
              <QuadrantPlayer
                slot={slot}
                streamId={stream?.id}
                resolved={stream && resolveStream(stream, delivery)}
                delivery={delivery}
                muted={isStreamMuted(state, slot)}
                focused={state.focused === slot}
                adActive={state.ad?.slot === slot}
                onTakeAudio={() => dispatch({ type: 'focus', slot })}
              />
              {showStats && stream && <StatsOverlay slot={slot} />}
              {state.ad?.slot === slot && (
                <AdOverlay
                  clipUrl={state.ad.clipUrl}
                  label={state.ad.label}
                  attribution={state.ad.attribution}
                  muted={isMuted(state, slot)}
                  onEnd={(error) => {
                    if (error) setAdMessage(error)
                    dispatch({ type: 'endAd' })
                  }}
                />
              )}
            </section>
          )
        })}
      </div>

      {showPanel && <TelemetryPanel />}
      {showBench && <BenchPanel />}

      <footer className="credits">
        {shown.map((s) => (
          <span key={s.id}>
            {s.title}: {s.attribution}, {s.license} {s.sourceUrl && <>(<a href={s.sourceUrl}>source</a>)</>}
          </span>
        ))}
      </footer>
    </div>
  )
}
