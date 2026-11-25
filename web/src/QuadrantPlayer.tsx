import { useEffect, useRef, useState } from 'react'
import shaka from 'shaka-player'
import { UNFOCUSED_MAX_HEIGHT } from '@shared/ladder.ts'
import { type Resolved } from './catalog'
import { DELIVERY_LABEL, type Delivery } from './deliveries'
import { Controls } from './Controls'
import { attachTelemetry, recordAbrCap, recordLoadStart } from './telemetry/shaka'

interface Props {
  slot: number
  streamId: string | undefined
  resolved: Resolved | undefined
  /** Why the source cannot offer anything yet (its index is loading or failed), if that is the reason. */
  note?: string
  delivery: Delivery
  muted: boolean
  focused: boolean
  /** Lift the 360p cap on unfocused quadrants, so quadrants can be compared at the same quality. */
  uncapped: boolean
  /** An ad is covering this quadrant, so the stream's own controls are hidden. */
  adActive: boolean
  onTakeAudio: () => void
}

export function QuadrantPlayer({ slot, streamId, resolved, note, delivery, muted, focused, uncapped, adActive, onTakeAudio }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const playerRef = useRef<shaka.Player | null>(null)
  // The video element outlives each player, and a player's destroy() resets the element after it
  // resolves. A new player must not attach until the previous one is gone, or its MediaSource is
  // wiped and attach() never settles (the quadrant stays black).
  const teardown = useRef<Promise<unknown>>(Promise.resolve())
  const [error, setError] = useState<string | null>(null)
  // Browsers refuse to start audible playback before the user has interacted with the page.
  const [blocked, setBlocked] = useState(false)
  const url = resolved?.url
  const mimeType = resolved?.mimeType

  useEffect(() => {
    setError(null)
    setBlocked(false)
    const video = videoRef.current
    if (!video || !streamId || !url) return
    shaka.polyfill.installAll()
    const player = new shaka.Player()
    playerRef.current = player
    const ctx = { slot, streamId, delivery }
    let cancelled = false
    let detach = () => {}
    const previous = teardown.current
    previous
      .then(() => (cancelled ? undefined : player.attach(video)))
      .then(() => {
        if (cancelled) return
        detach = attachTelemetry(player, video, ctx)
        recordLoadStart(ctx, url)
        return player.load(url, null, mimeType)
      })
      .then(() => (cancelled ? undefined : video.play()))
      .catch((e: { name?: string; code?: number; message?: string }) => {
        if (cancelled) return
        if (e.name === 'NotAllowedError') setBlocked(true)
        else setError(`Shaka error ${e.code ?? ''} ${e.message ?? ''}`.trim())
      })
    return () => {
      cancelled = true
      detach()
      playerRef.current = null
      teardown.current = previous.then(() => player.destroy()).catch(() => {})
    }
  }, [slot, streamId, url, mimeType, delivery])

  useEffect(() => {
    const maxHeight = focused || uncapped ? Infinity : UNFOCUSED_MAX_HEIGHT
    playerRef.current?.configure({ abr: { restrictions: { maxHeight } } })
    if (streamId && url) recordAbrCap({ slot, streamId, delivery }, maxHeight)
  }, [focused, uncapped, slot, streamId, url, delivery])

  return (
    <>
      <video
        ref={(el) => {
          videoRef.current = el
          setVideoEl(el)
        }}
        muted={muted}
        playsInline
      />
      {videoEl && streamId && resolved && !error && !adActive && (
        <Controls video={videoEl} playerRef={playerRef} audible={!muted} onTakeAudio={onTakeAudio} />
      )}
      {streamId && !resolved && <div className="msg">{note ?? `Not available via ${DELIVERY_LABEL[delivery]}`}</div>}
      {!streamId && note && <div className="msg err">{note}</div>}
      {blocked && !error && (
        <div className="msg">
          <button type="button" className="play-blocked" onClick={() => void videoEl?.play().then(() => setBlocked(false), () => {})}>
            ▶ Click to play
          </button>
        </div>
      )}
      {error && <div className="msg err">{error}</div>}
    </>
  )
}
