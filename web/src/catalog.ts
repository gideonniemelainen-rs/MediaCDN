export type StreamKind = 'VOD' | 'LIVE'

export interface Stream {
  id: string
  title: string
  kind: StreamKind
  /** Public URL, used until Media CDN is wired up. */
  directUrl: string
  /** Path on the Media CDN service; used instead of directUrl when VITE_CDN_BASE is set. */
  cdnPath?: string
}

// URLs are unverified: check they are alive and CORS-friendly before relying on them.
export const CATALOG: Stream[] = [
  {
    id: 'bbb-dash',
    title: 'Big Buck Bunny (DASH)',
    kind: 'VOD',
    directUrl: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
    cdnPath: '/s/akamai/akamai/bbb_30fps/bbb_30fps.mpd',
  },
  {
    id: 'bbb-hls',
    title: 'Big Buck Bunny (HLS)',
    kind: 'VOD',
    directUrl: 'https://storage.googleapis.com/shaka-demo-assets/bbb-dark-truths-hls/hls.m3u8',
  },
  {
    id: 'angel-one',
    title: 'Angel One (DASH)',
    kind: 'VOD',
    directUrl: 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
  },
  {
    id: 'dashif-live',
    title: 'DASH-IF test live (2s segments)',
    kind: 'LIVE',
    directUrl: 'https://livesim.dashif.org/livesim/testpic_2s/Manifest.mpd',
  },
]

const CDN_BASE = (import.meta.env.VITE_CDN_BASE as string | undefined)?.replace(/\/$/, '')

export function resolveUrl(stream: Stream): string {
  return CDN_BASE && stream.cdnPath ? CDN_BASE + stream.cdnPath : stream.directUrl
}

export function findStream(id: string | null): Stream | undefined {
  return id ? CATALOG.find((s) => s.id === id) : undefined
}
