export interface Ad {
  id: string
  label: string
  /** Progressive MP4 (CSAI overlay and VAST media file). */
  clipUrl: string
  durationSec: number
  attribution?: string
}

const env = import.meta.env as Record<string, string | undefined>
const trim = (s: string | undefined) => s?.replace(/\/$/, '')
/** Where ads are served from: origin/ads/ on the local origin for now (scripts/make-ads.mjs builds it). */
const ADS_BASE = trim(env.VITE_ADS_BASE) ?? trim(env.VITE_LOCAL_BASE) ?? 'http://localhost:8788'

/** Validates /ads/ads.json. Entries with a bad shape or a path outside /ads/ are dropped; a bad document throws. */
export function parseInventory(json: unknown, base = ADS_BASE): Ad[] {
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
let lastId: string | undefined

/** Forgets the cached inventory and the last pick (tests, and after the origin changes). */
export function resetAds() {
  inventory = undefined
  lastId = undefined
}

export function loadInventory(fetchFn: typeof fetch = fetch): Promise<Ad[]> {
  // Failures are not cached, so fixing the origin and clicking again works without a reload.
  inventory ??= (async () => {
    const url = `${ADS_BASE}/ads/ads.json`
    const res = await fetchFn(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`ad inventory: HTTP ${res.status} from ${url}`)
    return parseInventory(await res.json())
  })().catch((e) => {
    inventory = undefined
    throw e instanceof TypeError ? new Error(`ad inventory unreachable at ${ADS_BASE} (is serve-origin running?)`) : e
  })
  return inventory
}

export async function fetchAd(): Promise<Ad> {
  const ad = pickAd(await loadInventory(), lastId)
  lastId = ad.id
  return ad
}
