import { titleLocation, liveLocation, type TitleIndex } from '@shared/title-layout.ts'
import { type Delivery, type Transport, deliveryBase, indexPrefix, isEnabled, transportBase } from './deliveries'

export type StreamKind = 'VOD' | 'LIVE'
export type Protocol = 'progressive' | 'hls' | 'dash'

export interface Variant {
  protocol: Protocol
  /** Absolute URL for `direct`; a path under the delivery's base URL for the others. */
  location: string
}

export interface Stream {
  id: string
  /** Streams of the same title share a group, so presets can pick the right variant per delivery. */
  group: string
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

const BLENDER_WEB = 'https://video.blender.org/download/web-videos/'

interface Title {
  id: string
  title: string
  license: string
  attribution: string
  sourceUrl: string
  blenderFile: string
}

// Mirrors media/sources.json. URLs verified by scripts/probe-sources.mjs (docs/sources.md).
const TITLES: Title[] = [
  {
    id: 'llamigos',
    title: 'Caminandes 3: Llamigos',
    license: 'CC BY 3.0',
    attribution: '(CC) Blender Foundation | caminandes.com',
    sourceUrl: 'https://www.thestudio.io/osvideo/',
    blenderFile: '23f3ef79-15dc-44c5-aa45-cf92e78a4509-1080.mp4',
  },
  {
    id: 'agent-327',
    title: 'Agent 327: Operation Barbershop',
    license: 'CC BY 3.0',
    attribution: '(CC) Blender Foundation | agent327.com',
    sourceUrl: 'https://www.thestudio.io/osvideo/',
    blenderFile: '264ff760-803e-430e-8d81-15648e904183-804.mp4',
  },
  {
    id: 'coffee-run',
    title: 'Coffee Run',
    license: 'CC BY 3.0',
    attribution: '(CC) Blender Studio | studio.blender.org',
    sourceUrl: 'https://www.thestudio.io/osvideo/',
    blenderFile: 'ff8fe61b-026f-4f07-b66b-2a790d6f6ab1-720.mp4',
  },
  {
    id: 'bbb',
    title: 'Big Buck Bunny',
    license: 'CC BY 3.0',
    attribution: '(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org',
    sourceUrl: 'https://peach.blender.org/about/',
    blenderFile: 'bf1f3fb5-b119-4f9f-9930-8e20e892b898-720.mp4',
  },
  {
    id: 'sprite-fright',
    title: 'Sprite Fright',
    license: 'CC BY 3.0',
    attribution: '(CC) Blender Studio | studio.blender.org',
    sourceUrl: 'https://www.thestudio.io/osvideo/',
    blenderFile: 'a69d68a5-a0e0-4a80-9d66-49f093c97aaf-720.mp4',
  },
]

/** Per title: the public progressive file. Our own HLS/DASH/live copies come from the origin index. */
function fromTitle(t: Title): Stream[] {
  return [
    {
      group: t.id,
      license: t.license,
      attribution: t.attribution,
      sourceUrl: t.sourceUrl,
      id: t.id,
      title: t.title,
      kind: 'VOD',
      variants: {
        direct: { protocol: 'progressive', location: BLENDER_WEB + t.blenderFile },
        'cdn-public': { protocol: 'progressive', location: `/pub/blender/web-videos/${t.blenderFile}` },
      },
    },
  ]
}

export const CATALOG: Stream[] = [
  ...TITLES.flatMap(fromTitle),
  {
    id: 'akamai-bbb',
    group: 'akamai-bbb',
    title: 'Big Buck Bunny (Akamai DASH ladder)',
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
    group: 'dashif-live',
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

/**
 * The URL and protocol for a stream under a delivery mode, or undefined if it isn't offered there (or the delivery is disabled).
 * A transport picks the lab listener for the local origin and is ignored for every other delivery.
 */
export function resolveStream(stream: Stream, delivery: Delivery, transport?: Transport | null): Resolved | undefined {
  const variant = stream.variants[delivery]
  // A delivery the settings have switched off offers nothing; the quadrant says so (see App.tsx).
  if (!variant || !isEnabled(delivery)) return undefined
  if (delivery === 'direct') {
    return { url: variant.location, protocol: variant.protocol, mimeType: MIME[variant.protocol] }
  }
  const base = delivery === 'local' && transport ? transportBase(transport) : deliveryBase(delivery)
  return base
    ? { url: base + variant.location, protocol: variant.protocol, mimeType: MIME[variant.protocol] }
    : undefined
}

// ---------------------------------------------------------------------------------------------
// Streams derived from title indexes. Pure; the indexes themselves live in indexStore.ts.

const META = new Map(TITLES.map((t) => [t.id, t]))

/** Streams for every loaded index. A title listed by several deliveries becomes one stream with a variant per delivery. */
export function streamsFromIndexes(indexes: ReadonlyMap<Delivery, TitleIndex>): Stream[] {
  const byId = new Map<string, Stream>()
  const upsert = (id: string, make: () => Stream, delivery: Delivery, variant: Variant) => {
    const s = byId.get(id) ?? make()
    s.variants[delivery] = variant
    byId.set(id, s)
  }
  for (const [delivery, index] of indexes) {
    const prefix = indexPrefix(delivery)
    if (prefix === null) continue
    for (const t of index.titles) {
      const m = META.get(t.id)
      const meta = {
        group: t.id,
        license: m?.license ?? 'License not recorded',
        attribution: m?.attribution ?? 'No attribution recorded for this title',
        sourceUrl: m?.sourceUrl ?? '',
      }
      const name = m?.title ?? t.id
      if (t.protocols.includes('hls')) {
        upsert(`${t.id}-hls`, () => ({ ...meta, id: `${t.id}-hls`, title: `${name} (HLS)`, kind: 'VOD', variants: {} }), delivery, {
          protocol: 'hls',
          location: titleLocation(prefix, t.id, 'hls'),
        })
      }
      if (t.protocols.includes('dash')) {
        upsert(`${t.id}-dash`, () => ({ ...meta, id: `${t.id}-dash`, title: `${name} (DASH)`, kind: 'VOD', variants: {} }), delivery, {
          protocol: 'dash',
          location: titleLocation(prefix, t.id, 'dash'),
        })
      }
      if (t.live && delivery === 'local') {
        // only our local origin can simulate live; the flag is ignored elsewhere
        upsert(`live-${t.id}`, () => ({ ...meta, id: `live-${t.id}`, title: `${name} (simulated live, HLS)`, kind: 'LIVE', variants: {} }), delivery, {
          protocol: 'hls',
          location: liveLocation(t.id),
        })
      }
    }
  }
  // By title, then HLS, DASH, live: presets take the first match, and HLS is the default.
  const rank = (s: Stream) => (s.kind === 'LIVE' ? 2 : s.id.endsWith('-hls') ? 0 : 1)
  return [...byId.values()].sort((a, b) => a.group.localeCompare(b.group) || rank(a) - rank(b))
}

