// What the catalog does when the settings change under it: a new base URL means a new index, a disabled delivery offers nothing.
import type { TitleIndex } from '@shared/title-layout.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveStream } from './catalog'
import { setDeliveryOverrides } from './deliveries'
import { catalogVersion, clearIndexes, findStream, indexStatus, loadIndex, setIndex, streamsFor } from './indexStore'

afterEach(() => {
  setDeliveryOverrides()
  clearIndexes()
})

const INDEX: TitleIndex = { version: 1, titles: [{ id: 'bbb', protocols: ['hls'] }] }
const serve = (index: TitleIndex = INDEX) => vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(index)))

describe('a changed base URL', () => {
  it('loads from the new URL, and drops what the old one gave', async () => {
    setDeliveryOverrides({ 's3-near.base': 'https://one.example.com' })
    const fetchFn = serve()
    await loadIndex('s3-near', false, fetchFn)
    expect(fetchFn).toHaveBeenLastCalledWith('https://one.example.com/index.json', { cache: 'no-store' })
    expect(indexStatus('s3-near')).toEqual({ state: 'ready', count: 1 })

    setDeliveryOverrides({ 's3-near.base': 'https://two.example.com' })
    expect(indexStatus('s3-near')).toEqual({ state: 'idle' })
    expect(streamsFor('s3-near')).toEqual([])

    await loadIndex('s3-near', false, fetchFn)
    expect(fetchFn).toHaveBeenLastCalledWith('https://two.example.com/index.json', { cache: 'no-store' })
    expect(indexStatus('s3-near')).toEqual({ state: 'ready', count: 1 })
  })

  it('does not touch an index whose own URL did not move', async () => {
    setDeliveryOverrides({ 's3-near.base': 'https://one.example.com' })
    await loadIndex('s3-near', false, serve())
    const fetchFn = serve()
    await loadIndex('local', false, fetchFn)
    setDeliveryOverrides({ 's3-near.base': 'https://one.example.com', 's3-far.base': 'https://far.example.com' })
    expect(indexStatus('s3-near')).toEqual({ state: 'ready', count: 1 })
    expect(indexStatus('local')).toEqual({ state: 'ready', count: 1 })
  })

  it('keeps a failure on screen through a change that does not concern it', async () => {
    await loadIndex('local', false, vi.fn(async () => new Response('', { status: 500 })))
    const failed = indexStatus('local')
    expect(failed.state).toBe('error')
    setDeliveryOverrides({ 's3-far.base': 'https://far.example.com' })
    expect(indexStatus('local')).toEqual(failed)
  })

  it('discards an answer that arrives for a URL that is no longer current', async () => {
    setDeliveryOverrides({ 's3-near.base': 'https://old.example.com' })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = vi.fn(async () => {
      await gate
      return new Response(JSON.stringify({ version: 1, titles: [{ id: 'old-title', protocols: ['hls'] }] }))
    })
    const pending = loadIndex('s3-near', false, slow)

    setDeliveryOverrides({ 's3-near.base': 'https://new.example.com' })
    const fresh = serve({ version: 1, titles: [{ id: 'new-title', protocols: ['hls'] }] })
    await loadIndex('s3-near', false, fresh) // a second fetch starts: the running one is for the old URL
    release()
    await pending

    expect(fresh).toHaveBeenCalledTimes(1)
    expect(streamsFor('s3-near').map((s) => s.id)).toEqual(['new-title-hls'])
  })

  it('still shares one fetch between callers while the URL is the same', async () => {
    setDeliveryOverrides({ 's3-near.base': 'https://one.example.com' })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchFn = vi.fn(async () => {
      await gate
      return new Response(JSON.stringify(INDEX))
    })
    const a = loadIndex('s3-near', false, fetchFn)
    const b = loadIndex('s3-near', false, fetchFn)
    release()
    await Promise.all([a, b])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('a disabled delivery', () => {
  it('offers nothing, and comes back with its titles when switched on again', () => {
    setIndex('local', { version: 1, titles: [{ id: 'bbb', protocols: ['hls', 'dash'] }] })
    expect(streamsFor('local').map((s) => s.id)).toEqual(['bbb-hls', 'bbb-dash'])

    const before = catalogVersion()
    setDeliveryOverrides({ 'local.enabled': false })
    expect(catalogVersion()).toBeGreaterThan(before)
    expect(streamsFor('local')).toEqual([])
    expect(resolveStream(findStream('bbb-hls')!, 'local')).toBeUndefined()

    setDeliveryOverrides()
    expect(streamsFor('local').map((s) => s.id)).toEqual(['bbb-hls', 'bbb-dash'])
    expect(resolveStream(findStream('bbb-hls')!, 'local')?.url).toBe('http://localhost:8788/bbb/master.m3u8')
  })

  it('takes the public streams of the direct delivery away too', () => {
    expect(streamsFor('direct').length).toBeGreaterThan(0)
    setDeliveryOverrides({ 'direct.enabled': false })
    expect(streamsFor('direct')).toEqual([])
  })

  it('leaves the other deliveries alone', () => {
    setIndex('local', INDEX)
    setDeliveryOverrides({ 's3-near.enabled': false })
    expect(streamsFor('local').length).toBe(1)
  })
})
