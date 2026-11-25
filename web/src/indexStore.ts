import { parseIndex, type TitleIndex } from '@shared/title-layout.ts'
import { CATALOG, resolveStream, streamsFromIndexes, type Stream } from './catalog'
import { type Delivery, baseVarOf, indexUrl, isIndexed } from './deliveries'

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
  changed()
}

function setStatus(d: Delivery, status: IndexStatus) {
  statuses.set(d, status)
  changed()
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
    setStatus(delivery, { state: 'error', message: `no base URL configured (set ${baseVarOf(delivery)})` })
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
