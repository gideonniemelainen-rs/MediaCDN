import { describe, expect, it } from 'vitest'
import { CATALOG, findStream, resolveStream, streamsFor } from './catalog'

describe('resolveStream', () => {
  it('returns direct URLs untouched and tags progressive files with a mime type', () => {
    const r = resolveStream(findStream('bbb')!, 'direct')!
    expect(r.url).toMatch(/^https:\/\/video\.blender\.org\//)
    expect(r).toMatchObject({ protocol: 'progressive', mimeType: 'video/mp4' })
  })

  it('has no mime type for adaptive manifests', () => {
    expect(resolveStream(findStream('bbb-dash')!, 'direct')!.mimeType).toBeUndefined()
  })

  it('returns undefined where a delivery is not offered or not configured', () => {
    expect(resolveStream(findStream('dashif-live')!, 'local')).toBeUndefined()
    // no VITE_CDN_BASE in tests
    expect(resolveStream(findStream('bbb')!, 'cdn-public')).toBeUndefined()
  })

  it('lists only streams available under a delivery', () => {
    expect(streamsFor('direct').length).toBe(CATALOG.length)
    expect(streamsFor('cdn-s3')).toEqual([])
  })

  it('has attribution and license on every stream', () => {
    for (const s of CATALOG) expect(s.license && s.attribution && s.sourceUrl).toBeTruthy()
  })
})
