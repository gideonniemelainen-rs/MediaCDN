import { indexLocation, liveLocation, parseIndex, titleLocation, type TitleIndex } from '@shared/title-layout.ts'

export type StreamKind = 'VOD' | 'LIVE'
export type Protocol = 'progressive' | 'hls' | 'dash'

/**
 * How bytes reach the player:
 *  direct     public third-party URL, no CDN
 *  local      our own packaged origin on this machine
 *  s3-near    our S3 bucket read directly (no CDN), the one close to the viewer
 *  s3-far     the same content in a bucket far from the viewer, to show what distance costs
 *  cdn-public Media CDN in front of a public third-party origin
 *  cdn-s3     Media CDN in front of our private S3 bucket
 *
 * `local`, `s3-near`, `s3-far` and `cdn-s3` serve our own packaged titles, which are discovered at
 * runtime from each origin's index.json. `direct` and `cdn-public` use the built-in list of public
 * streams. Each quadrant picks its own delivery, so one title can be compared across several.
 */
export type Delivery = 'direct' | 'local' | 's3-near' | 's3-far' | 'cdn-public' | 'cdn-s3'
export const DELIVERIES: Delivery[] = ['direct', 'local', 's3-near', 's3-far', 'cdn-public', 'cdn-s3']

/** Names for the picker and the on-screen stats. The ids stay as they are in exports. */
export const DELIVERY_LABEL: Record<Delivery, string> = {
  direct: 'Direct (public)',
  local: 'Origin (local)',
  's3-near': 'S3 near',
  's3-far': 'S3 far',
  'cdn-public': 'Media CDN → public',
  'cdn-s3': 'Media CDN → S3',
}

/**
 * The HTTP version asked for, for the local origin only (see infra/local). The other deliveries
 * negotiate whatever their server offers, which the telemetry records as it was observed.
 */
export type Transport = 'h1' | 'h2' | 'h3'
export const TRANSPORTS: Transport[] = ['h1', 'h2', 'h3']

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

const env = import.meta.env as Record<string, string | undefined>
const trim = (s: string | undefined) => s?.replace(/\/$/, '')
const BASES: Partial<Record<Delivery, string>> = {
  local: trim(env.VITE_LOCAL_BASE) ?? 'http://localhost:8788',
  // VITE_S3_BASE predates the near/far split and still names the near bucket.
  's3-near': trim(env.VITE_S3_NEAR_BASE) ?? trim(env.VITE_S3_BASE),
  's3-far': trim(env.VITE_S3_FAR_BASE),
  'cdn-public': trim(env.VITE_CDN_BASE),
  'cdn-s3': trim(env.VITE_CDN_BASE),
}

/** The local origin behind the transport lab's listeners. Unset means that transport is not available. */
const TRANSPORT_VAR: Record<Transport, string> = { h1: 'VITE_LOCAL_BASE_H1', h2: 'VITE_LOCAL_BASE_H2', h3: 'VITE_LOCAL_BASE_H3' }
const TRANSPORT_BASES: Record<Transport, string | undefined> = {
  h1: trim(env.VITE_LOCAL_BASE_H1),
  h2: trim(env.VITE_LOCAL_BASE_H2),
  h3: trim(env.VITE_LOCAL_BASE_H3),
}

/** Why a requested transport cannot be used, or undefined when it can (or none was requested). */
export function transportProblem(delivery: Delivery, transport: Transport | null | undefined): string | undefined {
  if (!transport || delivery !== 'local') return undefined
  return TRANSPORT_BASES[transport] ? undefined : `Set ${TRANSPORT_VAR[transport]} to play over ${transport} (see infra/local/README.md)`
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
 * The URL and protocol for a stream under a delivery mode, or undefined if it isn't offered there.
 * A transport picks the lab listener for the local origin and is ignored for every other delivery.
 */
export function resolveStream(stream: Stream, delivery: Delivery, transport?: Transport | null): Resolved | undefined {
  const variant = stream.variants[delivery]
  if (!variant) return undefined
  if (delivery === 'direct') {
    return { url: variant.location, protocol: variant.protocol, mimeType: MIME[variant.protocol] }
  }
  const base = delivery === 'local' && transport ? TRANSPORT_BASES[transport] : BASES[delivery]
  return base
    ? { url: base + variant.location, protocol: variant.protocol, mimeType: MIME[variant.protocol] }
    : undefined
}

// ---------------------------------------------------------------------------------------------
// Title indexes: what each packaged origin currently offers.

export type IndexStatus = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; count: number } | { state: 'error'; message: string }

/** Deliveries whose titles come from an index, with the path prefix their index and media live under. */
const INDEX_PREFIX: Partial<Record<Delivery, string>> = { local: '', 's3-near': '', 's3-far': '', 'cdn-s3': '/s3' }
const BASE_VAR: Partial<Record<Delivery, string>> = {
  local: 'VITE_LOCAL_BASE',
  's3-near': 'VITE_S3_NEAR_BASE',
  's3-far': 'VITE_S3_FAR_BASE',
  'cdn-s3': 'VITE_CDN_BASE',
}
/** The indexed deliveries, in picker order. */
export const INDEXED_DELIVERIES = DELIVERIES.filter((d) => d in INDEX_PREFIX)
export const isIndexed = (d: Delivery) => d in INDEX_PREFIX

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
    const prefix = INDEX_PREFIX[delivery]
    if (prefix === undefined) continue
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

const indexes = new Map<Delivery, TitleIndex>()
const statuses = new Map<Delivery, IndexStatus>()
let derived: Stream[] = []
let version = 0
const listeners = new Set<() => void>()

function changed() {
  derived = streamsFromIndexes(indexes)
  version++
  listeners.forEach((l) => l())
}

export const subscribeCatalog = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
export const catalogVersion = () => version
export const indexStatus = (d: Delivery): IndexStatus => (isIndexed(d) ? (statuses.get(d) ?? { state: 'idle' }) : { state: 'ready', count: streamsFor(d).length })

export function setIndex(delivery: Delivery, index: TitleIndex) {
  indexes.set(delivery, index)
  statuses.set(delivery, { state: 'ready', count: index.titles.length })
  changed()
}

export function clearIndexes() {
  indexes.clear()
  statuses.clear()
  changed()
}

function setStatus(d: Delivery, status: IndexStatus) {
  statuses.set(d, status)
  changed()
}

export function indexUrl(delivery: Delivery): string | undefined {
  const base = BASES[delivery]
  const prefix = INDEX_PREFIX[delivery]
  return base && prefix !== undefined ? indexLocation(base, prefix) : undefined
}

const inflight = new Map<Delivery, Promise<void>>()

/**
 * Fetches a delivery's title index. A ready index is reused unless `force` is set (after an upload,
 * say). A call while a fetch is already running shares it, so awaiting `loadIndex` always means
 * "the index is as loaded as it is going to get".
 */
export function loadIndex(delivery: Delivery, force = false, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!isIndexed(delivery)) return Promise.resolve()
  const running = inflight.get(delivery)
  if (running) return running
  if (statuses.get(delivery)?.state === 'ready' && !force) return Promise.resolve()
  const url = indexUrl(delivery)
  if (!url) {
    setStatus(delivery, { state: 'error', message: `no base URL configured (set ${BASE_VAR[delivery]})` })
    return Promise.resolve()
  }
  setStatus(delivery, { state: 'loading' })
  const p = (async () => {
    try {
      const res = await fetchFn(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
      setIndex(delivery, parseIndex(await res.json()))
    } catch (e) {
      setStatus(delivery, { state: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      inflight.delete(delivery)
    }
  })()
  inflight.set(delivery, p)
  return p
}

export function streamsFor(delivery: Delivery): Stream[] {
  return [...CATALOG, ...derived].filter((s) => resolveStream(s, delivery))
}

/**
 * The stream to show after a quadrant switches delivery. The same stream if the new delivery
 * offers it (so one title stays put while the source changes); otherwise the same title's
 * equivalent there (the progressive file on `direct` becomes the HLS copy on `local`); otherwise
 * the current stream, which the quadrant reports as not available rather than silently emptying.
 */
export function streamForDelivery(streamId: string | null, delivery: Delivery): string | null {
  const current = findStream(streamId)
  if (!current || resolveStream(current, delivery)) return streamId
  const sameTitle = streamsFor(delivery).find((s) => s.group === current.group && s.kind === current.kind)
  return sameTitle?.id ?? streamId
}

export function findStream(id: string | null): Stream | undefined {
  return id ? (CATALOG.find((s) => s.id === id) ?? derived.find((s) => s.id === id)) : undefined
}

/**
 * The stream a preset entry stands for under a delivery: a title group (first variant offered) or
 * the literal 'live' (first live stream offered).
 */
export function pickForPreset(entry: string, delivery: Delivery): Stream | undefined {
  const offered = streamsFor(delivery)
  return entry === 'live' ? offered.find((s) => s.kind === 'LIVE') : offered.find((s) => s.group === entry)
}
