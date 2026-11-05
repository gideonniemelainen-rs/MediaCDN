export interface Ad {
  id: string
  clipUrl: string
}

// URLs are unverified. Later this becomes `fetch('/api/ad')` against the ad-decision service.
const AD_CLIPS: Ad[] = [
  { id: 'blazes', clipUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4' },
  { id: 'joyrides', clipUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4' },
  { id: 'escapes', clipUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4' },
]

export async function fetchAd(): Promise<Ad> {
  return AD_CLIPS[Math.floor(Math.random() * AD_CLIPS.length)]
}
