interface Props {
  clipUrl: string
  muted: boolean
  onEnd: () => void
}

export function AdOverlay({ clipUrl, muted, onEnd }: Props) {
  return (
    <div className="ad">
      <video src={clipUrl} autoPlay muted={muted} playsInline onEnded={onEnd} onError={onEnd} />
      <span className="ad-badge">Ad</span>
    </div>
  )
}
