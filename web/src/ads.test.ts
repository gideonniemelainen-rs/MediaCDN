import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAd, loadInventory, parseInventory, pickAd, resetAds } from './ads'

const BASE = 'http://origin.test'
const doc = {
  version: 1,
  ads: [
    { id: 'a', label: 'Ad A', kind: 'synthetic', durationSec: 6, mp4: '/ads/a/ad.mp4', hls: '/ads/a/master.m3u8' },
    { id: 'b', label: 'Ad B', durationSec: 15, mp4: '/ads/b/ad.mp4', attribution: 'CC BY cut' },
  ],
}

describe('parseInventory', () => {
  it('resolves clip URLs against the base and keeps attribution', () => {
    const ads = parseInventory(doc, BASE)
    expect(ads.map((a) => a.clipUrl)).toEqual([`${BASE}/ads/a/ad.mp4`, `${BASE}/ads/b/ad.mp4`])
    expect(ads[1].attribution).toBe('CC BY cut')
    expect(ads[0].attribution).toBeUndefined()
  })

  it('drops entries that are malformed or point outside /ads/', () => {
    const ads = parseInventory(
      {
        version: 1,
        ads: [
          { id: 'ok', label: 'ok', durationSec: 1, mp4: '/ads/ok/ad.mp4' },
          { id: 'escape', label: 'x', durationSec: 1, mp4: '/ads/../secret.mp4' },
          { id: 'elsewhere', label: 'x', durationSec: 1, mp4: '/media/bbb/chunk.m4s' },
          { id: 'absolute', label: 'x', durationSec: 1, mp4: 'https://evil.test/ad.mp4' },
          { id: 'nolabel', durationSec: 1, mp4: '/ads/nolabel/ad.mp4' },
          { id: 'strdur', label: 'x', durationSec: '6', mp4: '/ads/strdur/ad.mp4' },
        ],
      },
      BASE,
    )
    expect(ads.map((a) => a.id)).toEqual(['ok'])
  })

  it('rejects documents that are not an inventory', () => {
    expect(() => parseInventory({ ads: [] }, BASE)).toThrow(/not an ad inventory/)
    expect(() => parseInventory(null, BASE)).toThrow()
  })
})

describe('pickAd', () => {
  const ads = parseInventory(doc, BASE)

  it('avoids repeating the previous ad when there is a choice', () => {
    for (const r of [0, 0.5, 0.99]) expect(pickAd(ads, 'a', () => r).id).toBe('b')
  })

  it('repeats when there is only one ad, and fails when there are none', () => {
    expect(pickAd([ads[0]], 'a').id).toBe('a')
    expect(() => pickAd([])).toThrow(/no ads/)
  })
})

describe('loadInventory', () => {
  beforeEach(() => resetAds())
  const serving = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

  it('turns an unreachable origin into an actionable message and retries next time', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(loadInventory(down)).rejects.toThrow(/unreachable.*serve-origin/)
    // The failure was not cached: a working origin now succeeds.
    const up = serving(doc)
    expect((await loadInventory(up)).length).toBe(2)
    expect((await loadInventory(up)).length).toBe(2) // cached after success
    expect(up).toHaveBeenCalledTimes(1)
  })

  it('reports HTTP errors with the status and URL', async () => {
    await expect(loadInventory(serving({}, 404))).rejects.toThrow(/HTTP 404 from .*\/ads\/ads\.json/)
  })

  it('fetchAd never repeats the previous ad back to back', async () => {
    await loadInventory(serving(doc))
    let prev = (await fetchAd()).id
    for (let i = 0; i < 20; i++) {
      const next = (await fetchAd()).id
      expect(next).not.toBe(prev)
      prev = next
    }
  })
})

describe('the ads base follows the settings', () => {
  it('fetches the inventory from the overridden base, and again when the base changes', async () => {
    const { applySettings, resetSettings } = await import('./settings/store')
    try {
      resetAds()
      const fetchFn = vi.fn(async () => new Response(JSON.stringify(doc)))
      applySettings({ revision: 1, overrides: { player: { adsBase: 'https://ads-one.example.com/' } }, revisions: {} })
      const first = await loadInventory(fetchFn)
      await loadInventory(fetchFn)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(fetchFn).toHaveBeenLastCalledWith('https://ads-one.example.com/ads/ads.json', { cache: 'no-store' })
      expect(first[0].clipUrl).toBe('https://ads-one.example.com/ads/a/ad.mp4')

      applySettings({ revision: 2, overrides: { player: { adsBase: 'https://ads-two.example.com' } }, revisions: {} })
      const second = await loadInventory(fetchFn)
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(fetchFn).toHaveBeenLastCalledWith('https://ads-two.example.com/ads/ads.json', { cache: 'no-store' })
      expect(second[0].clipUrl).toBe('https://ads-two.example.com/ads/a/ad.mp4')
    } finally {
      resetSettings()
      resetAds()
    }
  })
})
