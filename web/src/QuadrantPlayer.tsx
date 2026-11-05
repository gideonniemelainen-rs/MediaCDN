import { useEffect, useRef } from 'react'
import shaka from 'shaka-player'
import { type Stream, resolveUrl } from './catalog'

interface Props {
  stream: Stream | undefined
  muted: boolean
  focused: boolean
}

// Cap unfocused quadrants so four concurrent decodes stay usable.
const UNFOCUSED_MAX_HEIGHT = 360

export function QuadrantPlayer({ stream, muted, focused }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playerRef = useRef<shaka.Player | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !stream) return
    shaka.polyfill.installAll()
    const player = new shaka.Player()
    playerRef.current = player
    let cancelled = false
    player
      .attach(video)
      .then(() => (cancelled ? undefined : player.load(resolveUrl(stream))))
      .then(() => (cancelled ? undefined : video.play()))
      .catch((e) => console.error('player error', stream.id, e))
    return () => {
      cancelled = true
      playerRef.current = null
      void player.destroy()
    }
  }, [stream])

  useEffect(() => {
    playerRef.current?.configure({
      abr: { restrictions: { maxHeight: focused ? Infinity : UNFOCUSED_MAX_HEIGHT } },
    })
  }, [focused, stream])

  return <video ref={videoRef} muted={muted} playsInline />
}
