import { useMemo } from 'react'
import { describeStage, formatDuration, stageElapsed, statusWord } from './format'
import { NODE_H, NODE_W, layoutGraph } from './graph-layout'
import type { Stage, StageStatus } from './types'

const DONE: StageStatus[] = ['success', 'cached']

/** Colour of the connector into `to`, like the green line between finished jobs in a workflow run. */
function edgeTone(to: Stage): 'ok' | 'run' | 'bad' | 'idle' {
  if (DONE.includes(to.status)) return 'ok'
  if (to.status === 'running') return 'run'
  if (to.status === 'failed') return 'bad'
  return 'idle'
}

function StatusIcon({ status }: { status: StageStatus }) {
  const common = { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': true, className: `icon ${status}` } as const
  switch (status) {
    case 'running':
      return (
        <svg {...common}>
          <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
          <path d="M9 2a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )
    case 'success':
    case 'cached':
      return (
        <svg {...common}>
          <circle cx="9" cy="9" r="8" fill="currentColor" strokeDasharray={status === 'cached' ? '3 2' : undefined} />
          <path d="M5.2 9.2l2.6 2.6 5-5.4" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'failed':
      return (
        <svg {...common}>
          <circle cx="9" cy="9" r="8" fill="currentColor" />
          <path d="M6 6l6 6M12 6l-6 6" stroke="#111" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )
    case 'skipped':
      return (
        <svg {...common}>
          <circle cx="9" cy="9" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.5 12.5l7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx="9" cy="9" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )
  }
}

interface Props {
  stages: Stage[]
  selected: string | null
  onSelect: (id: string) => void
  now: number
}

/** The pipeline as a left-to-right graph of stage cards, laid out from the stages' `needs`. */
export function WorkflowGraph({ stages, selected, onSelect, now }: Props) {
  const shape = stages.map((s) => `${s.id}:${s.needs.join('+')}`).join('|')
  // The layout depends only on ids and needs (captured by `shape`), not on status, so it is not
  // recomputed on every progress tick.
  const layout = useMemo(() => layoutGraph(stages), [shape]) // oxlint-disable-line react-hooks/exhaustive-deps
  const byId = new Map(stages.map((s) => [s.id, s]))

  return (
    <div className="wf-scroll">
      <div className="wf" style={{ width: layout.width, height: layout.height }}>
        <svg className="wf-edges" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map((e) => {
            const to = byId.get(e.to)
            return <path key={`${e.from}>${e.to}`} d={e.d} className={`edge ${to ? edgeTone(to) : 'idle'}`} />
          })}
        </svg>
        {layout.nodes.map((n) => {
          const s = byId.get(n.id)
          if (!s) return null
          const t = stageElapsed(s, now)
          return (
            <button
              key={s.id}
              type="button"
              className={`wf-node ${s.status}${selected === s.id ? ' selected' : ''}`}
              style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
              aria-pressed={selected === s.id}
              aria-label={describeStage(s, now)}
              onClick={() => onSelect(s.id)}
            >
              <StatusIcon status={s.status} />
              <span className="wf-label">{s.label}</span>
              <span className="wf-time">{t === null ? statusWord(s.status) : formatDuration(t)}</span>
              {s.status === 'running' && s.progress !== null && (
                <span className="wf-bar" aria-hidden="true">
                  <i style={{ width: `${Math.round(s.progress * 100)}%` }} />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
