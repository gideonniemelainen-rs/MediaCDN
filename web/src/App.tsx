import { useReducer } from 'react'
import { AdOverlay } from './AdOverlay'
import { fetchAd } from './ads'
import { CATALOG, findStream } from './catalog'
import { QuadrantPlayer } from './QuadrantPlayer'
import { SLOT_COUNT, initialState, isMuted, isStreamMuted, pickAdSlot, reducer } from './state'
import './index.css'

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)

  async function triggerAd() {
    const slot = pickAdSlot(state)
    if (slot === null || state.ad) return
    const ad = await fetchAd()
    dispatch({ type: 'startAd', slot, clipUrl: ad.clipUrl })
  }

  return (
    <>
    <button className="ad-trigger" onClick={triggerAd} disabled={!!state.ad}>
      Trigger ad
    </button>
    <div className="grid">
      {Array.from({ length: SLOT_COUNT }, (_, slot) => (
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
            {CATALOG.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} [{s.kind}]
              </option>
            ))}
          </select>
          <QuadrantPlayer
            stream={findStream(state.slots[slot])}
            muted={isStreamMuted(state, slot)}
            focused={state.focused === slot}
          />
          {state.ad?.slot === slot && (
            <AdOverlay
              clipUrl={state.ad.clipUrl}
              muted={isMuted(state, slot)}
              onEnd={() => dispatch({ type: 'endAd' })}
            />
          )}
        </section>
      ))}
    </div>
    </>
  )
}
