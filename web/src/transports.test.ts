// Per-quadrant transport: which lab listener the local origin is read through.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Stream } from './catalog'
import { SLOT_COUNT, initialState, reducer } from './state'

const bbb: Stream = {
  id: 'bbb-hls', group: 'bbb', title: 'Big Buck Bunny (HLS)', kind: 'VOD', license: '', attribution: '', sourceUrl: '',
  variants: { local: { protocol: 'hls', location: '/bbb/master.m3u8' }, 's3-near': { protocol: 'hls', location: '/bbb/master.m3u8' } },
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function catalogWith(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  // Both modules, loaded after the reset so they share one fresh copy of the env-built table.
  return { ...(await import('./catalog')), ...(await import('./deliveries')) }
}

describe('transport state', () => {
  it('starts with the default transport in every quadrant', () => {
    expect(initialState.transports).toEqual(Array(SLOT_COUNT).fill(null))
  })

  it('sets one quadrant, ignores a no-op or a bad slot, and drops an ad over the reloaded stream', () => {
    const s = reducer(initialState, { type: 'setTransport', slot: 1, transport: 'h3' })
    expect(s.transports).toEqual([null, 'h3', null, null])
    expect(reducer(s, { type: 'setTransport', slot: 1, transport: 'h3' })).toBe(s)
    expect(reducer(initialState, { type: 'setTransport', slot: 9, transport: 'h2' })).toBe(initialState)
    const withAd = { ...s, slots: ['a', 'b', 'c', 'd'], ad: { slot: 1, clipUrl: 'x' } }
    expect(reducer(withAd, { type: 'setTransport', slot: 1, transport: 'h2' }).ad).toBeNull()
    expect(reducer(withAd, { type: 'setTransport', slot: 2, transport: 'h2' }).ad).not.toBeNull()
  })
})

describe('resolving a stream over a transport', () => {
  it('uses the lab listener for the local origin when it is configured', async () => {
    const c = await catalogWith({ VITE_LOCAL_BASE_H2: 'https://localhost:8442/', VITE_LOCAL_BASE_H3: 'https://localhost:8443' })
    expect(c.resolveStream(bbb, 'local', 'h2')?.url).toBe('https://localhost:8442/bbb/master.m3u8')
    expect(c.resolveStream(bbb, 'local', 'h3')?.url).toBe('https://localhost:8443/bbb/master.m3u8')
    expect(c.transportProblem('local', 'h3')).toBeUndefined()
  })

  it('uses the plain local origin with no transport, and ignores a transport elsewhere', async () => {
    const c = await catalogWith({ VITE_LOCAL_BASE_H3: 'https://localhost:8443', VITE_S3_NEAR_BASE: 'https://near.test' })
    expect(c.resolveStream(bbb, 'local')?.url).toBe('http://localhost:8788/bbb/master.m3u8')
    expect(c.resolveStream(bbb, 'local', null)?.url).toBe('http://localhost:8788/bbb/master.m3u8')
    expect(c.resolveStream(bbb, 's3-near', 'h3')?.url).toBe('https://near.test/bbb/master.m3u8')
    expect(c.transportProblem('s3-near', 'h3')).toBeUndefined()
  })

  it('does not fall back to another listener when the one asked for is not configured', async () => {
    const c = await catalogWith({ VITE_LOCAL_BASE_H1: 'https://localhost:8441' })
    expect(c.resolveStream(bbb, 'local', 'h3')).toBeUndefined()
    expect(c.transportProblem('local', 'h3')).toMatch(/Set VITE_LOCAL_BASE_H3 to play over h3/)
    expect(c.transportProblem('local', 'h1')).toBeUndefined()
    expect(c.transportProblem('local', null)).toBeUndefined()
  })
})
