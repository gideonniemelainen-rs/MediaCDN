import { parseIndex, type TitleIndex } from '@shared/title-layout.ts'
import { CATALOG, resolveStream, streamsFromIndexes, type Stream } from './catalog'
import { INDEXED_DELIVERIES, type Delivery, baseVarOf, indexUrl, isIndexed, subscribeDeliveries } from './deliveries'

// Title indexes: what each packaged origin currently offers, and the streams derived from them. This is the mutable
// part of the catalog; catalog.ts holds the static data and the pure derivation.

export type IndexStatus = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; count: number } | { state: 'error'; message: string }

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
  loadedFrom.clear()
  changed()
}

function setStatus(d: Delivery, status: IndexStatus) {
  statuses.set(d, status)
  changed()
}

/** The fetch that is running for a delivery, and the URL it is fetching: a result for a URL that is no longer current is dropped. */
const inflight = new Map<Delivery, { url: string; promise: Promise<void> }>()
/** The URL each delivery's index (loading, loaded or failed) is for, so a changed base URL can tell which are stale. */
const loadedFrom = new Map<Delivery, string>()

/**
 * Fetches a delivery's title index. A ready index is reused unless `force` is set (after an upload,
 * say). A call while a fetch is already running shares it, so awaiting `loadIndex` always means
 * "the index is as loaded as it is going to get".
 */
export function loadIndex(delivery: Delivery, force = false, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!isIndexed(delivery)) return Promise.resolve()
  const url = indexUrl(delivery)
  const running = inflight.get(delivery)
  if (running && running.url === url) return running.promise
  if (statuses.get(delivery)?.state === 'ready' && !force) return Promise.resolve()
  if (!url) {
    loadedFrom.delete(delivery)
    setStatus(delivery, { state: 'error', message: `no base URL configured (set ${baseVarOf(delivery)})` })
    return Promise.resolve()
  }
  loadedFrom.set(delivery, url)
  setStatus(delivery, { state: 'loading' })
  const stale = () => indexUrl(delivery) !== url
  const promise = (async () => {
    try {
      const res = await fetchFn(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
      const index = parseIndex(await res.json())
      if (stale()) return // the base URL changed while this was loading; the new URL has its own fetch
      setIndex(delivery, index)
    } catch (e) {
      if (!stale()) setStatus(delivery, { state: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      if (inflight.get(delivery)?.url === url) inflight.delete(delivery)
    }
  })()
  inflight.set(delivery, { url, promise })
  return promise
}

// When a delivery's base URL changes, whatever was loaded from the old one describes a different server: drop it, so
// the next load starts clean. Enabling or disabling a delivery needs no reload, only a fresh derivation of the streams.
subscribeDeliveries(() => {
  for (const d of INDEXED_DELIVERIES) {
    // Only what is known to come from a URL that is no longer current: an index set directly has no recorded URL.
    if (loadedFrom.has(d) && loadedFrom.get(d) !== indexUrl(d)) {
      indexes.delete(d)
      statuses.delete(d)
      loadedFrom.delete(d)
    }
  }
  changed()
})

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
