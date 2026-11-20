import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CATALOG,
  type TitleIndex,
  clearIndexes,
  findStream,
  indexStatus,
  indexUrl,
  loadIndex,
  parseIndex,
  pickForPreset,
  resolveStream,
  setIndex,
  streamsFor,
  streamsFromIndexes,
} from './catalog'

const LOCAL_INDEX: TitleIndex = {
  version: 1,
  titles: [
    { id: 'bbb', protocols: ['hls', 'dash'], live: true },
    { id: 'selftest', protocols: ['hls'] },
  ],
}

afterEach(() => clearIndexes())

describe('public streams (direct)', () => {
  it('returns direct URLs untouched and tags progressive files with a mime type', () => {
    const r = resolveStream(findStream('bbb')!, 'direct')!
    expect(r.url).toMatch(/^https:\/\/video\.blender\.org\//)
    expect(r).toMatchObject({ protocol: 'progressive', mimeType: 'video/mp4' })
  })

  it('has no mime type for adaptive manifests', () => {
    expect(resolveStream(findStream('akamai-bbb')!, 'direct')!.mimeType).toBeUndefined()
  })

  it('is not offered under deliveries it has no variant for, or that are not configured', () => {
    expect(resolveStream(findStream('dashif-live')!, 'local')).toBeUndefined()
    expect(resolveStream(findStream('bbb')!, 'local')).toBeUndefined()
    // no VITE_CDN_BASE or VITE_S3_BASE in tests
    expect(resolveStream(findStream('bbb')!, 'cdn-public')).toBeUndefined()
  })

  it('has unique ids, and attribution and license on every stream', () => {
    expect(new Set(CATALOG.map((s) => s.id)).size).toBe(CATALOG.length)
    for (const s of CATALOG) expect(s.license && s.attribution && s.sourceUrl).toBeTruthy()
  })
})

describe('parseIndex', () => {
  it('accepts a valid index and drops unsafe ids and unknown protocols', () => {
    const idx = parseIndex({
      version: 1,
      titles: [
        { id: 'ok', protocols: ['hls', 'smooth'] },
        { id: '../evil', protocols: ['hls'] },
        { id: 'none', protocols: ['smooth'] },
        { id: 'x', protocols: 'hls' },
      ],
    })
    expect(idx.titles).toEqual([{ id: 'ok', protocols: ['hls'] }])
  })

  it('rejects documents that are not an index', () => {
    expect(() => parseIndex({ titles: [] })).toThrow(/not a title index/)
    expect(() => parseIndex(null)).toThrow()
    expect(() => parseIndex({ version: 2, titles: [] })).toThrow()
  })
})

describe('index-driven deliveries', () => {
  it('offers nothing until an index is loaded', () => {
    expect(streamsFor('local')).toEqual([])
    expect(findStream('bbb-hls')).toBeUndefined()
  })

  it('builds HLS, DASH and live streams from the index, with metadata for known titles', () => {
    setIndex('local', LOCAL_INDEX)
    expect(streamsFor('local').map((s) => s.id)).toEqual(['bbb-hls', 'bbb-dash', 'live-bbb', 'selftest-hls'])
    const hls = findStream('bbb-hls')!
    expect(hls.title).toBe('Big Buck Bunny (HLS)')
    expect(hls.license).toBe('CC BY 3.0')
    expect(resolveStream(hls, 'local')!.url).toBe('http://localhost:8788/bbb/master.m3u8')
    expect(resolveStream(findStream('live-bbb')!, 'local')!.url).toBe('http://localhost:8788/live/bbb/master.m3u8')
  })

  it('falls back to the id and an explicit unknown license for titles it has no metadata for', () => {
    setIndex('local', LOCAL_INDEX)
    const s = findStream('selftest-hls')!
    expect(s.title).toBe('selftest (HLS)')
    expect(s.license).toBe('License not recorded')
  })

  it('merges one title across deliveries and only offers it where its index lists it', () => {
    const merged = streamsFromIndexes(
      new Map([
        ['local', LOCAL_INDEX],
        ['s3-near', { version: 1, titles: [{ id: 'bbb', protocols: ['hls'] }] } as TitleIndex],
      ]),
    )
    const bbb = merged.find((s) => s.id === 'bbb-hls')!
    expect(Object.keys(bbb.variants).sort()).toEqual(['local', 's3-near'])
    expect(merged.find((s) => s.id === 'selftest-hls')!.variants['s3-near']).toBeUndefined()
    expect(merged.find((s) => s.id === 'bbb-dash')!.variants['s3-near']).toBeUndefined()
  })

  it('puts the cdn-s3 index and media under /s3', () => {
    const merged = streamsFromIndexes(new Map([['cdn-s3', LOCAL_INDEX]]))
    expect(merged.find((s) => s.id === 'bbb-hls')!.variants['cdn-s3']!.location).toBe('/s3/bbb/master.m3u8')
    expect(merged.find((s) => s.id === 'live-bbb')).toBeUndefined() // live is local-only, whatever the index says
  })

  it('maps preset entries to the variant each delivery offers', () => {
    setIndex('local', LOCAL_INDEX)
    expect(pickForPreset('bbb', 'direct')?.id).toBe('bbb')
    expect(pickForPreset('bbb', 'local')?.id).toBe('bbb-hls')
    expect(pickForPreset('live', 'direct')?.id).toBe('dashif-live')
    expect(pickForPreset('live', 'local')?.id).toBe('live-bbb')
    expect(pickForPreset('llamigos', 'local')).toBeUndefined() // not packaged
    expect(pickForPreset('bbb', 'cdn-public')).toBeUndefined() // no CDN base configured in tests
  })
})

describe('loadIndex', () => {
  const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body)))

  it('fetches <base>/index.json and records the status', async () => {
    const fetchFn = ok(LOCAL_INDEX)
    await loadIndex('local', false, fetchFn)
    expect(fetchFn).toHaveBeenCalledWith('http://localhost:8788/index.json', { cache: 'no-store' })
    expect(indexStatus('local')).toEqual({ state: 'ready', count: 2 })
  })

  it('reuses a ready index unless forced', async () => {
    const fetchFn = ok(LOCAL_INDEX)
    await loadIndex('local', false, fetchFn)
    await loadIndex('local', false, fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await loadIndex('local', true, fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('reports HTTP failures and malformed documents without throwing', async () => {
    await loadIndex('local', false, vi.fn(async () => new Response('nope', { status: 403 })))
    expect(indexStatus('local')).toMatchObject({ state: 'error', message: expect.stringContaining('HTTP 403') })
    await loadIndex('local', true, ok({ hello: 'world' }))
    expect(indexStatus('local')).toMatchObject({ state: 'error', message: expect.stringContaining('not a title index') })
  })

  it('says which variable to set when a delivery has no base URL', async () => {
    expect(indexUrl('s3-near')).toBeUndefined()
    await loadIndex('s3-near', false, ok(LOCAL_INDEX))
    expect(indexStatus('s3-near')).toEqual({ state: 'error', message: 'no base URL configured (set VITE_S3_NEAR_BASE)' })
    await loadIndex('s3-far', false, ok(LOCAL_INDEX))
    expect(indexStatus('s3-far')).toEqual({ state: 'error', message: 'no base URL configured (set VITE_S3_FAR_BASE)' })
  })

  it('does nothing for deliveries without an index', async () => {
    const fetchFn = ok(LOCAL_INDEX)
    await loadIndex('direct', false, fetchFn)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
