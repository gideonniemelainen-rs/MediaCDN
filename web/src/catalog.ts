export type StreamKind = 'VOD' | 'LIVE'
export type Protocol = 'progressive' | 'hls' | 'dash'

/**
 * How bytes reach the player:
 *  direct     public third-party URL, no CDN
 *  local      our own packaged origin on this machine
 *  cdn-public Media CDN in front of a public third-party origin
 *  cdn-s3     Media CDN in front of our private S3 bucket
 */
export type Delivery = 'direct' | 'local' | 'cdn-public' | 'cdn-s3'
export const DELIVERIES: Delivery[] = ['direct', 'local', 'cdn-public', 'cdn-s3']

export interface Variant {
  protocol: Protocol
  /** Absolute URL for `direct`; a path under the delivery's base URL for the others. */
  location: string
}

export interface Stream {
  id: string
  title: string
  kind: StreamKind
  license: string
  attribution: string
  sourceUrl: string
  variants: Partial<Record<Delivery, Variant>>
}

export interface Resolved {
  url: string
  protocol: Protocol
  /** Shaka needs a mime type to play a progressive file. */
  mimeType?: string
}

const env = import.meta.env as Record<string, string | undefined>
const trim = (s: string | undefined) => s?.replace(/\/$/, '')
const BASES: Partial<Record<Delivery, string>> = {
  local: trim(env.VITE_LOCAL_BASE) ?? 'http://localhost:8788',
  'cdn-public': trim(env.VITE_CDN_BASE),
  'cdn-s3': trim(env.VITE_CDN_BASE),
}

const BLENDER_WEB = 'https://video.blender.org/download/web-videos/'
const blenderMp4 = (file: string): Pick<Stream, 'variants'> => ({
  variants: {
    direct: { protocol: 'progressive', location: BLENDER_WEB + file },
    'cdn-public': { protocol: 'progressive', location: `/pub/blender/web-videos/${file}` },
  },
})

// Titles and licenses come from media/sources.json and docs/sources.md; URLs are unverified
// until scripts/probe-sources.mjs has been run.
export const CATALOG: Stream[] = [
  {
    id: 'llamigos',
    title: 'Caminandes 3: Llamigos',
    kind: 'VOD',
    license: 'CC BY 3.0',
    attribution: '(CC) Blender Foundation | caminandes.com',
    sourceUrl: 'https://www.thestudio.io/osvideo/',
    ...blenderMp4('23f3ef79-15dc-44c5-aa45-cf92e78a4509-1080.mp4'),
  },
  {
    id: 'agent-327',
    title: 'Agent 327: Operation Barbershop',
    kind: 'VOD',
    license: 'CC BY 3.0',
    attribution: '(CC) Blender Foundation | agent327.com',
    sourceUrl: 'https://www.thestudio.io/osvideo/',
    ...blenderMp4('264ff760-803e-430e-8d81-15648e904183-804.mp4'),
  },
  {
    id: 'coffee-run',
    title: 'Coffee Run',
    kind: 'VOD',
    license: 'CC BY 3.0',
    attribution: '(CC) Blender Studio | studio.blender.org',
    sourceUrl: 'https://www.thestudio.io/osvideo/',
    ...blenderMp4('ff8fe61b-026f-4f07-b66b-2a790d6f6ab1-720.mp4'),
  },
  {
    id: 'bbb',
    title: 'Big Buck Bunny',
    kind: 'VOD',
    license: 'CC BY 3.0',
    attribution: '(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org',
    sourceUrl: 'https://peach.blender.org/about/',
    ...blenderMp4('bf1f3fb5-b119-4f9f-9930-8e20e892b898-720.mp4'),
  },
  {
    id: 'sprite-fright',
    title: 'Sprite Fright',
    kind: 'VOD',
    license: 'CC BY 3.0',
    attribution: '(CC) Blender Studio | studio.blender.org',
    sourceUrl: 'https://www.thestudio.io/osvideo/',
    ...blenderMp4('a69d68a5-a0e0-4a80-9d66-49f093c97aaf-720.mp4'),
  },
  {
    id: 'bbb-dash',
    title: 'Big Buck Bunny (DASH ladder)',
    kind: 'VOD',
    license: 'CC BY 3.0',
    attribution: '(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org; packaged by Akamai',
    sourceUrl: 'https://dash.akamaized.net/akamai/bbb_30fps/',
    variants: {
      direct: { protocol: 'dash', location: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd' },
      'cdn-public': { protocol: 'dash', location: '/pub/akamai/akamai/bbb_30fps/bbb_30fps.mpd' },
    },
  },
  {
    id: 'dashif-live',
    title: 'DASH-IF live test (2 s segments)',
    kind: 'LIVE',
    license: 'DASH-IF test stream',
    attribution: 'DASH Industry Forum livesim',
    sourceUrl: 'https://livesim.dashif.org/',
    variants: {
      direct: { protocol: 'dash', location: 'https://livesim.dashif.org/livesim/testpic_2s/Manifest.mpd' },
    },
  },
]

const MIME: Record<Protocol, string | undefined> = {
  progressive: 'video/mp4',
  hls: undefined,
  dash: undefined,
}

/** The URL and protocol for a stream under a delivery mode, or undefined if it isn't offered there. */
export function resolveStream(stream: Stream, delivery: Delivery): Resolved | undefined {
  const variant = stream.variants[delivery]
  if (!variant) return undefined
  if (delivery === 'direct') {
    return { url: variant.location, protocol: variant.protocol, mimeType: MIME[variant.protocol] }
  }
  const base = BASES[delivery]
  return base
    ? { url: base + variant.location, protocol: variant.protocol, mimeType: MIME[variant.protocol] }
    : undefined
}

export function streamsFor(delivery: Delivery): Stream[] {
  return CATALOG.filter((s) => resolveStream(s, delivery))
}

export function findStream(id: string | null): Stream | undefined {
  return id ? CATALOG.find((s) => s.id === id) : undefined
}
