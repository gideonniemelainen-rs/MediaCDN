import { useReducer, useState } from 'react'
import { AdOverlay } from './AdOverlay'
import { fetchAd } from './ads'
import { DELIVERIES, type Delivery, findStream, pickForPreset, resolveStream, streamsFor } from './catalog'
import { QuadrantPlayer } from './QuadrantPlayer'
import { StatsOverlay } from './StatsOverlay'
import { SLOT_COUNT, initialState, isMuted, isStreamMuted, pickAdSlot, reducer } from './state'
import { TelemetryPanel } from './TelemetryPanel'
import './index.css'

// Fixed layouts so repeated runs are comparable. Entries are title groups or 'live'; each resolves
// to whichever variant the current delivery offers, and to an empty quadrant if none.
const PRESETS: Record<string, string[]> = {
  '4x same title': ['bbb', 'bbb', 'bbb', 'bbb'],
  'mixed VOD + live': ['llamigos', 'agent-327', 'bbb', 'live'],
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [delivery, setDelivery] = useState<Delivery>('direct')
  const [showStats, setShowStats] = useState(true)
  const [showPanel, setShowPanel] = useState(true)
  const offered = streamsFor(delivery)

  function applyPreset(ids: string[]) {
    ids.forEach((entry, slot) => {
      dispatch({ type: 'setStream', slot, streamId: pickForPreset(entry, delivery)?.id ?? null })
    })
  }

  async function triggerAd() {
    const slot = pickAdSlot(state)
    if (slot === null || state.ad) return
    const ad = await fetchAd()
    dispatch({ type: 'startAd', slot, clipUrl: ad.clipUrl })
  }

  const shown = [...new Set(state.slots)].map(findStream).filter((s) => s !== undefined)

  return (
    <div className="app">
      <header className="bar">
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
        <button onClick={triggerAd} disabled={!!state.ad}>
          Trigger ad
        </button>
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
                  muted={isMuted(state, slot)}
                  onEnd={() => dispatch({ type: 'endAd' })}
                />
              )}
            </section>
          )
        })}
      </div>

      {showPanel && <TelemetryPanel />}

      <footer className="credits">
        {shown.map((s) => (
          <span key={s.id}>
            {s.title}: {s.attribution}, {s.license} (<a href={s.sourceUrl}>source</a>)
          </span>
        ))}
      </footer>
    </div>
  )
}
