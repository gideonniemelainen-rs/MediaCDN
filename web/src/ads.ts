import { playerSettings } from './settings/store'

export interface Ad {
  id: string
  label: string
  /** Progressive MP4 (CSAI overlay and VAST media file). */
  clipUrl: string
  durationSec: number
  attribution?: string
}

/** Where ads are served from: origin/ads/ on the local origin unless the settings say otherwise (scripts/make-ads.mjs builds it). */
const adsBase = () => playerSettings().adsBase

/** Validates /ads/ads.json. Entries with a bad shape or a path outside /ads/ are dropped; a bad document throws. */
export function parseInventory(json: unknown, base = adsBase()): Ad[] {
  const j = json as { version?: unknown; ads?: unknown } | null
  if (!j || j.version !== 1 || !Array.isArray(j.ads)) throw new Error('not an ad inventory (expected version 1 and ads[])')
  const ads: Ad[] = []
  for (const a of j.ads as Record<string, unknown>[]) {
    const mp4 = a?.mp4
    if (typeof a?.id !== 'string' || typeof a.label !== 'string' || typeof a.durationSec !== 'number') continue
    if (typeof mp4 !== 'string' || !mp4.startsWith('/ads/') || mp4.includes('..')) continue
    ads.push({
      id: a.id,
      label: a.label,
      clipUrl: base + mp4,
      durationSec: a.durationSec,
      ...(typeof a.attribution === 'string' ? { attribution: a.attribution } : {}),
    })
  }
  return ads
}

/** A random ad, avoiding an immediate repeat of `lastId` when there is a choice. */
export function pickAd(ads: Ad[], lastId?: string, random: () => number = Math.random): Ad {
  if (!ads.length) throw new Error('no ads available')
  const pool = ads.length > 1 ? ads.filter((a) => a.id !== lastId) : ads
  return pool[Math.floor(random() * pool.length)]
}

let inventory: Promise<Ad[]> | undefined
/** The base the cached inventory was fetched from: a changed base (a setting) is a different inventory. */
let inventoryBase: string | undefined
let lastId: string | undefined

/** Forgets the cached inventory and the last pick (tests, and after the origin changes). */
export function resetAds() {
  inventory = undefined
  inventoryBase = undefined
  lastId = undefined
}

export function loadInventory(fetchFn: typeof fetch = fetch): Promise<Ad[]> {
  const base = adsBase()
  if (inventoryBase !== base) inventory = undefined
  inventoryBase = base
  // Failures are not cached, so fixing the origin and clicking again works without a reload.
  const p: Promise<Ad[]> = (inventory ??= (async () => {
    const url = `${base}/ads/ads.json`
    const res = await fetchFn(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`ad inventory: HTTP ${res.status} from ${url}`)
    return parseInventory(await res.json(), base)
  })().catch((e) => {
    if (inventory === p) inventory = undefined
    throw e instanceof TypeError ? new Error(`ad inventory unreachable at ${base} (is serve-origin running?)`) : e
  }))
  return p
}

export async function fetchAd(): Promise<Ad> {
  const ad = pickAd(await loadInventory(), lastId)
  lastId = ad.id
  return ad
}
