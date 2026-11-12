import { type RefObject, useEffect, useState } from 'react'
import type shaka from 'shaka-player'

interface Props {
  video: HTMLVideoElement
  playerRef: RefObject<shaka.Player | null>
  /** True when this quadrant owns the audio. */
  audible: boolean
  onTakeAudio: () => void
}

interface View {
  paused: boolean
  time: number
  start: number
  end: number
  live: boolean
}

const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

function readView(video: HTMLVideoElement, player: shaka.Player | null): View {
  const live = player?.isLive() ?? false
  const range = player?.seekRange()
  const start = range && Number.isFinite(range.end) && range.end > 0 ? range.start : 0
  const end = range && Number.isFinite(range.end) && range.end > 0 ? range.end : video.duration || 0
  return { paused: video.paused, time: video.currentTime, start, end, live }
}

export function Controls({ video, playerRef, audible, onTakeAudio }: Props) {
  const [v, setV] = useState<View>({ paused: true, time: 0, start: 0, end: 0, live: false })

  useEffect(() => {
    const update = () => setV(readView(video, playerRef.current))
    const events = ['play', 'pause', 'timeupdate', 'durationchange', 'loadedmetadata', 'seeked', 'emptied']
    events.forEach((e) => video.addEventListener(e, update))
    update()
    return () => events.forEach((e) => video.removeEventListener(e, update))
  }, [video, playerRef])

  const seek = (t: number) => {
    video.currentTime = t
  }
  const togglePlay = () => (video.paused ? void video.play() : video.pause())
  const behindLive = v.live ? Math.max(0, v.end - v.time) : 0

  return (
    <div className="controls" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button onClick={togglePlay} title={v.paused ? 'Play' : 'Pause'} aria-label={v.paused ? 'Play' : 'Pause'}>
        {v.paused ? '▶' : '⏸'}
      </button>
      <input
        type="range"
        min={v.start}
        max={Math.max(v.end, v.start + 0.1)}
        step={0.1}
        value={Math.min(Math.max(v.time, v.start), Math.max(v.end, v.start + 0.1))}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Seek"
      />
      {v.live ? (
        <button
          className={behindLive < 6 ? 'live on' : 'live'}
          onClick={() => seek(v.end)}
          title="Jump to the live edge"
        >
          LIVE{behindLive >= 6 ? ` -${fmt(behindLive)}` : ''}
        </button>
      ) : (
        <span className="time">
          {fmt(v.time)} / {fmt(v.end)}
        </span>
      )}
      <button
        onClick={onTakeAudio}
        className={audible ? 'audio on' : 'audio'}
        title={audible ? 'This box has the audio' : 'Play audio from this box'}
        aria-label={audible ? 'Audio on' : 'Play audio from this box'}
        aria-pressed={audible}
      >
        {audible ? '🔊' : '🔇'}
      </button>
      <button
        onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : video.parentElement?.requestFullscreen())}
        title="Fullscreen"
        aria-label="Fullscreen"
      >
        ⛶
      </button>
    </div>
  )
}
