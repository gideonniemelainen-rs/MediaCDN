import { useEffect, useRef, useState } from 'react'
import shaka from 'shaka-player'
import { DELIVERY_LABEL, type Delivery, type Resolved } from './catalog'
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
  /** An ad is covering this quadrant, so the stream's own controls are hidden. */
  adActive: boolean
  onTakeAudio: () => void
}

// Cap unfocused quadrants so four concurrent decodes stay usable.
const UNFOCUSED_MAX_HEIGHT = 360

export function QuadrantPlayer({ slot, streamId, resolved, note, delivery, muted, focused, adActive, onTakeAudio }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const playerRef = useRef<shaka.Player | null>(null)
  const [error, setError] = useState<string | null>(null)
  const url = resolved?.url
  const mimeType = resolved?.mimeType

  useEffect(() => {
    setError(null)
    const video = videoRef.current
    if (!video || !streamId || !url) return
    shaka.polyfill.installAll()
    const player = new shaka.Player()
    playerRef.current = player
    const ctx = { slot, streamId, delivery }
    let cancelled = false
    let detach = () => {}
    player
      .attach(video)
      .then(() => {
        if (cancelled) return
        detach = attachTelemetry(player, video, ctx)
        recordLoadStart(ctx, url)
        return player.load(url, null, mimeType)
      })
      .then(() => (cancelled ? undefined : video.play()))
      .catch((e: { code?: number; message?: string }) => {
        if (!cancelled) setError(`Shaka error ${e.code ?? ''} ${e.message ?? ''}`.trim())
      })
    return () => {
      cancelled = true
      detach()
      playerRef.current = null
      void player.destroy()
    }
  }, [slot, streamId, url, mimeType, delivery])

  useEffect(() => {
    const maxHeight = focused ? Infinity : UNFOCUSED_MAX_HEIGHT
    playerRef.current?.configure({ abr: { restrictions: { maxHeight } } })
    if (streamId && url) recordAbrCap({ slot, streamId, delivery }, maxHeight)
  }, [focused, slot, streamId, url, delivery])

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
      {error && <div className="msg err">{error}</div>}
    </>
  )
}
