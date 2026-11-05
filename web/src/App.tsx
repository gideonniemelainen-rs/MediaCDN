import { useReducer } from 'react'
import { CATALOG, findStream } from './catalog'
import { QuadrantPlayer } from './QuadrantPlayer'
import { SLOT_COUNT, initialState, isMuted, reducer } from './state'
import './index.css'

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)

  return (
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
            muted={isMuted(state, slot)}
            focused={state.focused === slot}
          />
        </section>
      ))}
    </div>
  )
}
