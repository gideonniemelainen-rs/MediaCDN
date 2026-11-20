import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import shaka from 'shaka-player'
import { catalogVersion, findStream, loadIndex, resolveStream, subscribeCatalog } from '../catalog'

/**
 * Plays a freshly published title through the same path the main app uses: reload the local
 * index, find `<id>-hls`, resolve it for the local delivery. If it shows up here, it shows up there.
 */
export function ResultPlayer({ id }: { id: string }) {
  useSyncExternalStore(subscribeCatalog, catalogVersion)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const streamId = `${id}-hls`

  useEffect(() => {
    void loadIndex('local', true)
  }, [id])

  const stream = findStream(streamId)
  const resolved = stream && resolveStream(stream, 'local')
  const url = resolved?.url
  const mimeType = resolved?.mimeType

  useEffect(() => {
    setError(null)
    const video = videoRef.current
    if (!video || !url) return
    shaka.polyfill.installAll()
    const player = new shaka.Player()
    let cancelled = false
    player
      .attach(video)
      .then(() => (cancelled ? undefined : player.load(url, null, mimeType)))
      .catch((e: { code?: number; message?: string }) => {
        if (!cancelled) setError(`Could not play ${url} (Shaka error ${e.code ?? ''}). Is tools/serve-origin.mjs running?`)
      })
    return () => {
      cancelled = true
      void player.destroy()
    }
  }, [url, mimeType])

  return (
    <section className="detail result" aria-label="Result">
      <header className="detail-head">
        <h2>Result</h2>
        <a className="button-link" href={`/?delivery=local&stream=${encodeURIComponent(streamId)}`}>
          Open in main app
        </a>
      </header>
      {!stream && <p className="muted">Waiting for the title to appear in the local index…</p>}
      {error && <p className="note bad">{error}</p>}
      <video ref={videoRef} controls playsInline hidden={!url} />
    </section>
  )
}
