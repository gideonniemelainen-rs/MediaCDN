import { useEffect, useReducer, useRef, useState } from 'react'
import { AdOverlay } from './AdOverlay'
import { fetchAd } from './ads'
import { resolveStream } from './catalog'
import { DELIVERIES, DELIVERY_LABEL, TRANSPORTS, type Delivery, type Transport, isIndexed, transportProblem } from './deliveries'
import { findStream, loadIndex, pickForPreset, streamForDelivery, streamsFor } from './indexStore'
import { useCatalogs } from './useCatalog'
import { QuadrantPlayer } from './QuadrantPlayer'
import { StatsOverlay } from './StatsOverlay'
import { SLOT_COUNT, initialState, isMuted, isStreamMuted, pickAdSlot, reducer } from './state'
import { readLaunch } from './launch'
import { BenchPanel } from './BenchPanel'
import { TelemetryPanel } from './TelemetryPanel'
import NavBar from './NavBar'
import './index.css'

// Fixed layouts so repeated runs are comparable. Entries are title groups or 'live'; each resolves
// to whichever variant its quadrant's delivery offers, and to an empty quadrant if none. A slot
// without a delivery keeps the one it already has.
interface PresetSlot {
  entry: string
  delivery?: Delivery
  /** Only meaningful for the local origin; a slot without one keeps its own. */
  transport?: Transport | null
}
const same = (entry: string, delivery?: Delivery): PresetSlot[] => Array.from({ length: 4 }, () => ({ entry, delivery }))
const PRESETS: Record<string, PresetSlot[]> = {
  '4x same title': same('bbb'),
  // Live is only simulated by the local origin.
  'mixed VOD + live': ['llamigos', 'agent-327', 'bbb', 'live'].map((entry) => ({ entry, delivery: 'local' })),
  // One title, four ways of getting it: the comparison this tool is for.
  // One title over the lab's h1, h2 and h3 listeners, and the plain local origin for reference.
  'compare transports': (['h1', 'h2', 'h3', null] as const).map((transport) => ({ entry: 'bbb', delivery: 'local' as const, transport })),
  'compare deliveries': (['local', 's3-near', 's3-far', 'cdn-s3'] as const).map((delivery) => ({ entry: 'bbb', delivery })),
}

// Presets whose point is to compare quadrants: they lift the cap so the comparison is at equal quality.
const COMPARING = new Set(['compare transports', 'compare deliveries'])

export default function App() {
  // /?delivery=local&stream=<id>-hls is how the upload page opens a published title here.
  const [launch] = useState(() => readLaunch(window.location.search))
  const [state, dispatch] = useReducer(reducer, launch, (l) => {
    let s = initialState
    if (l.delivery) s = reducer(s, { type: 'setDelivery', slot: 0, delivery: l.delivery })
    if (l.stream) s = reducer(s, { type: 'setStream', slot: 0, streamId: l.stream })
    return s
  })
  const [showStats, setShowStats] = useState(true)
  const [showPanel, setShowPanel] = useState(true)
  const [showBench, setShowBench] = useState(false)
  // Unfocused quadrants are capped at 360p, which makes bitrate and segment times incomparable with the focused one.
  const [uncapped, setUncapped] = useState(false)
  const [adMessage, setAdMessage] = useState<string | null>(null)
  const { indexed, statusOf, reload } = useCatalogs(state.deliveries)

  // Handlers that wait for an index to load need the state as it is then, not when they started.
  const latest = useRef(state)
  useEffect(() => {
    latest.current = state
  })

  // A preset entry the delivery doesn't offer (e.g. a title that isn't packaged yet) falls back to
  // whichever VOD titles are available, so presets still fill the grid; 'live' stays empty if absent.
  async function applyPreset(name: string, preset: PresetSlot[]) {
    if (COMPARING.has(name)) setUncapped(true)
    const deliveries = preset.map((p, slot) => p.delivery ?? latest.current.deliveries[slot])
    // Titles are discovered from each delivery's index, so wait for the ones this layout needs.
    await Promise.all(deliveries.map((d) => loadIndex(d)))
    preset.forEach(({ entry }, slot) => {
      const delivery = deliveries[slot]
      const vod = streamsFor(delivery).filter((s) => s.kind === 'VOD')
      const pick = pickForPreset(entry, delivery) ?? (entry === 'live' ? undefined : vod[slot % Math.max(1, vod.length)])
      dispatch({ type: 'setDelivery', slot, delivery })
      if (preset[slot].transport !== undefined) dispatch({ type: 'setTransport', slot, transport: preset[slot].transport ?? null })
      dispatch({ type: 'setStream', slot, streamId: pick?.id ?? null })
    })
  }

  // Switching a quadrant's source keeps its title where the new source has it, and otherwise
  // moves to that title's equivalent there (the public MP4 becomes the HLS copy, say).
  async function changeDelivery(slot: number, delivery: Delivery) {
    dispatch({ type: 'setDelivery', slot, delivery })
    await loadIndex(delivery)
    const streamId = streamForDelivery(latest.current.slots[slot], delivery)
    if (streamId !== latest.current.slots[slot]) dispatch({ type: 'setStream', slot, streamId })
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
      <NavBar current="player" />
      <header className="bar">
        <span className="catalog-status">
          {indexed.map((d) => {
            const st = statusOf(d)
            return (
              <span key={d} className={st.state === 'error' ? 'error' : undefined}>
                {DELIVERY_LABEL[d]}: {st.state === 'ready' ? `${st.count} titles` : st.state === 'error' ? st.message : 'loading…'}
              </span>
            )
          })}
        </span>
        {indexed.length > 0 && <button onClick={reload}>Reload titles</button>}
        {Object.entries(PRESETS).map(([name, preset]) => (
          <button key={name} onClick={() => void applyPreset(name, preset)}>
            {name}
          </button>
        ))}
        <label>
          <input type="checkbox" checked={showStats} onChange={(e) => setShowStats(e.target.checked)} /> stats
        </label>
        <label>
          <input type="checkbox" checked={showPanel} onChange={(e) => setShowPanel(e.target.checked)} /> telemetry
        </label>
        <label title="Lift the 360p cap on unfocused quadrants, so quadrants are compared at the same quality">
          <input type="checkbox" checked={uncapped} onChange={(e) => setUncapped(e.target.checked)} /> uncapped
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
          const delivery = state.deliveries[slot]
          const offered = streamsFor(delivery)
          // Say why a quadrant is empty or unavailable when the cause is its source's index.
          const index = isIndexed(delivery) ? statusOf(delivery) : null
          const transport = state.transports[slot]
          const note =
            transportProblem(delivery, transport) ??
            (index?.state === 'error' ? index.message : index?.state === 'loading' ? 'Loading titles…' : undefined)
          return (
            <section
              key={slot}
              className={state.focused === slot ? 'quad focused' : 'quad'}
              onClick={() => dispatch({ type: 'focus', slot })}
            >
              <div className="quad-pickers" onClick={(e) => e.stopPropagation()}>
                <select
                  aria-label={`Quadrant ${slot + 1} delivery`}
                  value={delivery}
                  onChange={(e) => void changeDelivery(slot, e.target.value as Delivery)}
                >
                  {DELIVERIES.map((d) => (
                    <option key={d} value={d}>
                      {DELIVERY_LABEL[d]}
                    </option>
                  ))}
                </select>
                {delivery === 'local' && (
                  <select
                    aria-label={`Quadrant ${slot + 1} transport`}
                    value={transport ?? ''}
                    onChange={(e) => dispatch({ type: 'setTransport', slot, transport: (e.target.value || null) as Transport | null })}
                  >
                    <option value="">default</option>
                    {TRANSPORTS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  aria-label={`Quadrant ${slot + 1} stream`}
                  value={state.slots[slot] ?? ''}
                  onChange={(e) => dispatch({ type: 'setStream', slot, streamId: e.target.value || null })}
                >
                  <option value="">(empty)</option>
                  {stream && !offered.some((s) => s.id === stream.id) && <option value={stream.id}>{stream.title} (not offered here)</option>}
                  {offered.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title} [{s.kind}]
                    </option>
                  ))}
                </select>
              </div>
              <QuadrantPlayer
                slot={slot}
                streamId={stream?.id}
                resolved={stream && !transportProblem(delivery, transport) ? resolveStream(stream, delivery, transport) : undefined}
                note={note}
                delivery={delivery}
                muted={isStreamMuted(state, slot)}
                focused={state.focused === slot}
                uncapped={uncapped}
                adActive={state.ad?.slot === slot}
                onTakeAudio={() => dispatch({ type: 'focus', slot })}
              />
              {showStats && stream && <StatsOverlay slot={slot} delivery={delivery} />}
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
