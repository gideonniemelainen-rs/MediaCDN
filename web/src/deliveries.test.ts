// Per-quadrant delivery: the choices that let one title be compared across several sources.
import type { TitleIndex } from '@shared/title-layout.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DELIVERIES, DELIVERY_LABEL, INDEXED_DELIVERIES, clearIndexes, indexStatus, isIndexed, loadIndex, setIndex, streamForDelivery,
} from './catalog'
import { readLaunch } from './launch'
import { SLOT_COUNT, initialState, reducer } from './state'

const INDEX: TitleIndex = { version: 1, titles: [{ id: 'bbb', protocols: ['hls', 'dash'], live: true }] }

afterEach(() => clearIndexes())

describe('deliveries', () => {
  it('splits S3 into a near and a far bucket, each with its own index', () => {
    expect(DELIVERIES).toEqual(['direct', 'local', 's3-near', 's3-far', 'cdn-public', 'cdn-s3'])
    expect(INDEXED_DELIVERIES).toEqual(['local', 's3-near', 's3-far', 'cdn-s3'])
    expect(isIndexed('s3-near') && isIndexed('s3-far')).toBe(true)
    expect(isIndexed('direct') || isIndexed('cdn-public')).toBe(false)
  })

  it('has a distinct label for every delivery', () => {
    const labels = DELIVERIES.map((d) => DELIVERY_LABEL[d])
    expect(new Set(labels).size).toBe(DELIVERIES.length)
    expect(DELIVERY_LABEL.local).toBe('Origin (local)')
  })

  it('accepts the new deliveries in the launch URL and rejects the old one', () => {
    expect(readLaunch('?delivery=s3-far&stream=bbb-hls')).toEqual({ delivery: 's3-far', stream: 'bbb-hls' })
    expect(readLaunch('?delivery=s3')).toEqual({})
  })

  it('shares one fetch between callers while an index is loading', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchFn = vi.fn(async () => {
      await gate
      return new Response(JSON.stringify(INDEX))
    })
    const a = loadIndex('local', false, fetchFn)
    const b = loadIndex('local', false, fetchFn)
    expect(indexStatus('local')).toEqual({ state: 'loading' })
    release()
    await Promise.all([a, b])
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(indexStatus('local')).toEqual({ state: 'ready', count: 1 })
  })

  it('can be loaded again after a failed attempt', async () => {
    await loadIndex('local', false, vi.fn(async () => new Response('', { status: 500 })))
    expect(indexStatus('local')).toMatchObject({ state: 'error' })
    await loadIndex('local', false, vi.fn(async () => new Response(JSON.stringify(INDEX))))
    expect(indexStatus('local')).toEqual({ state: 'ready', count: 1 })
  })
})

describe('streamForDelivery', () => {
  it('keeps the stream when the new delivery offers it', () => {
    setIndex('local', INDEX)
    // bbb-hls is on the local origin only in this test, but the same id is what other buckets list too
    expect(streamForDelivery('bbb-hls', 'local')).toBe('bbb-hls')
    expect(streamForDelivery('bbb', 'direct')).toBe('bbb')
  })

  it("moves to the same title's equivalent where the stream itself is not offered", () => {
    setIndex('local', INDEX)
    expect(streamForDelivery('bbb', 'local')).toBe('bbb-hls') // public MP4 -> our HLS copy
    expect(streamForDelivery('bbb-hls', 'direct')).toBe('bbb') // and back
  })

  it('keeps the stream (to be shown as unavailable) when the title is not there', () => {
    setIndex('local', INDEX)
    expect(streamForDelivery('llamigos', 'local')).toBe('llamigos') // not packaged
    expect(streamForDelivery('bbb-hls', 's3-far')).toBe('bbb-hls') // that source has no index loaded
  })

  it('never turns live into video on demand or the other way round', () => {
    setIndex('local', INDEX)
    expect(streamForDelivery('live-bbb', 'direct')).toBe('live-bbb') // no live copy of bbb on direct
    expect(streamForDelivery('dashif-live', 'local')).toBe('dashif-live')
  })

  it('passes an empty quadrant and an unknown stream through', () => {
    expect(streamForDelivery(null, 'local')).toBeNull()
    expect(streamForDelivery('nope', 'local')).toBe('nope')
  })
})

describe('per-quadrant delivery state', () => {
  it('starts every quadrant on direct', () => {
    expect(initialState.deliveries).toEqual(Array(SLOT_COUNT).fill('direct'))
  })

  it('sets one quadrant without touching the others or the streams', () => {
    const withStream = reducer(initialState, { type: 'setStream', slot: 1, streamId: 'bbb-hls' })
    const s = reducer(withStream, { type: 'setDelivery', slot: 1, delivery: 's3-far' })
    expect(s.deliveries).toEqual(['direct', 's3-far', 'direct', 'direct'])
    expect(s.slots).toEqual(withStream.slots)
  })

  it('returns the same state for a no-op or an out-of-range slot', () => {
    expect(reducer(initialState, { type: 'setDelivery', slot: 0, delivery: 'direct' })).toBe(initialState)
    expect(reducer(initialState, { type: 'setDelivery', slot: 9, delivery: 'local' })).toBe(initialState)
    expect(reducer(initialState, { type: 'setDelivery', slot: -1, delivery: 'local' })).toBe(initialState)
  })

  it('ends an ad over the quadrant whose source changed, and leaves other ads alone', () => {
    let s = [0, 1, 2].reduce((acc, slot) => reducer(acc, { type: 'setStream', slot, streamId: 'bbb-hls' }), initialState)
    s = reducer(s, { type: 'startAd', slot: 1, clipUrl: 'x' })
    expect(reducer(s, { type: 'setDelivery', slot: 1, delivery: 'local' }).ad).toBeNull()
    expect(reducer(s, { type: 'setDelivery', slot: 2, delivery: 'local' }).ad).not.toBeNull()
  })
})
