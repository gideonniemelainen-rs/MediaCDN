import { useEffect, useRef, useState } from 'react'

interface Props {
  clipUrl: string
  label?: string
  attribution?: string
  muted: boolean
  /** Called once when the ad finishes, or with a reason when it could not play. */
  onEnd: (error?: string) => void
}

const MEDIA_ERRORS: Record<number, string> = {
  1: 'aborted',
  2: 'network error',
  3: 'decode error',
  4: 'source not supported or not found',
}

/** How long a failure message stays up before the overlay goes away, so it can actually be read. */
const ERROR_MS = 4000

export function AdOverlay({ clipUrl, label, attribution, muted, onEnd }: Props) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [mutedByBrowser, setMutedByBrowser] = useState(false)
  // The parent passes a fresh function every render; the error timer must not restart because of that.
  const onEndRef = useRef(onEnd)
  useEffect(() => {
    onEndRef.current = onEnd
  })

  // React does not keep the muted property in sync after mount, and focus can change mid-ad.
  useEffect(() => {
    if (video.current) video.current.muted = muted || mutedByBrowser
  }, [muted, mutedByBrowser])

  useEffect(() => {
    const el = video.current
    if (!el) return
    el.play().catch((e: unknown) => {
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        // Autoplay with sound was refused: fall back to muted playback rather than losing the ad.
        setMutedByBrowser(true)
        el.muted = true
        el.play().catch((e2: unknown) => setError(`autoplay blocked (${e2 instanceof Error ? e2.message : e2})`))
      } else if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }, [clipUrl])

  useEffect(() => {
    if (!error) return
    const id = setTimeout(() => onEndRef.current(error), ERROR_MS)
    return () => clearTimeout(id)
  }, [error])

  return (
    <div className="ad">
      <video
        ref={video}
        src={clipUrl}
        playsInline
        onEnded={() => onEnd()}
        onError={(e) => setError(MEDIA_ERRORS[e.currentTarget.error?.code ?? 0] ?? 'unknown media error')}
      />
      <span className="ad-badge" title={attribution}>
        Ad{label ? ` · ${label}` : ''}
        {mutedByBrowser ? ' (muted by browser)' : ''}
      </span>
      {attribution && <span className="ad-credit">{attribution}</span>}
      {error && (
        <div className="ad-error" role="alert">
          Ad failed: {error}
          <small>{clipUrl}</small>
        </div>
      )}
    </div>
  )
}
