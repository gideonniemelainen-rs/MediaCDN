import type { ReactNode } from 'react'
import { formatBytes, formatDuration, stageElapsed, statusWord } from './format'
import type {
  NormaliseResult, PackageResult, ProbeResult, PublishResult, Stage, UploadResult, ValidateResult, VerifyResult,
} from './types'

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const fps = (n: number) => `${Number(n.toFixed(2))} fps`

function Upload({ r }: { r: UploadResult }) {
  return <Rows rows={[['File', r.name], ['Size', formatBytes(r.bytes)], ['Rate', `${r.mbPerSecond} MB/s`], ['sha256', <code key="h">{r.sha256.slice(0, 16)}…</code>]]} />
}

function Probe({ r }: { r: ProbeResult }) {
  const { info } = r
  const v = info.video
  return (
    <Rows
      rows={[
        ['Container', info.container],
        ['Duration', `${info.duration.toFixed(1)} s`],
        ...(v
          ? ([
              ['Video', `${v.codec}, ${v.displayWidth}×${v.displayHeight}${v.rotation ? ` (rotated ${v.rotation}°)` : ''}`],
              ['Frame rate', v.vfr ? `variable, averaging ${fps(v.avgFps)}` : fps(v.rFps)],
              ['Pixel format', `${v.pixFmt}, ${v.bitDepth}-bit${v.hdr ? ', HDR' : ''}${v.interlaced ? ', interlaced' : ''}`],
            ] as [string, ReactNode][])
          : []),
        ['Audio', info.audio.length ? info.audio.map((a) => `${a.codec} ${a.channels}ch ${a.sampleRate} Hz`).join('; ') : 'none'],
      ]}
    />
  )
}

function Validate({ r }: { r: ValidateResult }) {
  return (
    <>
      {r.errors.map((e) => (
        <p key={e.code} className="note bad">
          <code>{e.code}</code> {e.message}
          {e.detail ? ` (${e.detail})` : ''}
        </p>
      ))}
      {r.warnings.length === 0 && r.errors.length === 0 && <p className="note">No warnings.</p>}
      {r.warnings.map((w) => (
        <p key={w.code} className="note warn">
          <code>{w.code}</code> {w.detail ?? ''}
        </p>
      ))}
    </>
  )
}

function Normalise({ r }: { r: NormaliseResult }) {
  const d = r.decisions
  return (
    <Rows
      rows={[
        ['Frame rate', `${fps(d.sourceFps)} → ${d.fps} fps constant`],
        ['Audio', d.audio.synthesised ? 'none in source, silence added' : `track ${d.audio.track} of ${d.audio.tracks}, stereo`],
        ['Colour', d.tonemapped ? 'HDR tonemapped to SDR BT.709' : '8-bit SDR BT.709'],
        ['Orientation', d.rotated ? `rotated ${d.rotated}°` : 'as recorded'],
        ['Loudness', d.loudnorm],
        ['Mezzanine', formatBytes(r.mezzanineBytes)],
        ['Job', <code key="k">{r.key}</code>],
      ]}
    />
  )
}

function Package({ r }: { r: PackageResult }) {
  return (
    <>
      <table className="rungs">
        <thead>
          <tr><th>Rung</th><th>Video bitrate</th></tr>
        </thead>
        <tbody>
          {r.rungs.map((g) => (
            <tr key={g.height}><td>{g.height}p</td><td>{g.kbps} kbps</td></tr>
          ))}
        </tbody>
      </table>
      <Rows rows={[['Output size', formatBytes(r.bytes)]]} />
    </>
  )
}

function Verify({ r }: { r: VerifyResult }) {
  return (
    <ul className="checks">
      {r.checks.map((c) => (
        <li key={c.name} className={c.ok ? 'ok' : 'bad'}>
          <span aria-hidden="true">{c.ok ? '✓' : '✗'}</span> {c.name}
          {c.detail && <small> {c.detail}</small>}
          <span className="sr-only">{c.ok ? ' passed' : ' failed'}</span>
        </li>
      ))}
    </ul>
  )
}

function Publish({ r }: { r: PublishResult }) {
  return <Rows rows={[['Title id', <code key="i">{r.id}</code>], ['Directory', r.path], ['HLS', r.urls.hls], ['DASH', r.urls.dash]]} />
}

// The field each stage's result must carry to be shown. A failed stage's result may be just
// `{ code }` (a probe that could not read the file, say), which these components cannot render.
const REQUIRES: Record<string, string> = {
  upload: 'bytes', probe: 'info', validate: 'warnings', normalise: 'decisions', package: 'rungs', verify: 'checks', publish: 'urls',
}

function Result({ stage }: { stage: Stage }) {
  const r = stage.result
  if (!r) return null
  const need = REQUIRES[stage.id]
  if (need && !(need in r)) return null
  switch (stage.id) {
    case 'upload': return <Upload r={r as unknown as UploadResult} />
    case 'probe': return <Probe r={r as unknown as ProbeResult} />
    case 'validate': return <Validate r={r as unknown as ValidateResult} />
    case 'normalise': return <Normalise r={r as unknown as NormaliseResult} />
    case 'package': return <Package r={r as unknown as PackageResult} />
    case 'verify': return <Verify r={r as unknown as VerifyResult} />
    case 'publish': return <Publish r={r as unknown as PublishResult} />
    default: return <pre className="log">{JSON.stringify(r, null, 2)}</pre>
  }
}

/** The selected stage's outcome: what it decided, what it found, and the tail of its log. */
export function StageDetails({ stage, now }: { stage: Stage; now: number }) {
  const t = stageElapsed(stage, now)
  const failure = stage.status === 'failed' ? (stage.result as { code?: string } | null)?.code : undefined
  // A failed validate lists its errors below, so repeating the first one as the summary says it twice.
  const errorsListed = stage.id === 'validate' && ((stage.result as { errors?: unknown[] } | null)?.errors?.length ?? 0) > 0
  return (
    <section className="detail" aria-label={`${stage.label} details`}>
      <header className="detail-head">
        <h2>{stage.label}</h2>
        <span className={`chip ${stage.status}`}>{statusWord(stage.status)}</span>
        {t !== null && <span className="muted">{formatDuration(t)}</span>}
        {stage.status === 'running' && stage.progress !== null && <span className="muted">{Math.round(stage.progress * 100)}%</span>}
      </header>
      {stage.summary && !errorsListed && <p className={stage.status === 'failed' ? 'note bad' : 'summary'}>{failure && <code>{failure}</code>} {stage.summary}</p>}
      {stage.status === 'queued' && <p className="muted">Waiting for earlier stages.</p>}
      {stage.status === 'skipped' && <p className="muted">Skipped because an earlier stage failed.</p>}
      <Result stage={stage} />
      {stage.log.length > 0 && <pre className="log" aria-label="Log">{stage.log.join('\n')}</pre>}
    </section>
  )
}
