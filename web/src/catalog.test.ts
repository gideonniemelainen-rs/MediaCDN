import { describe, expect, it } from 'vitest'
import { CATALOG, findStream, pickForPreset, resolveStream, streamsFor } from './catalog'

describe('resolveStream', () => {
  it('returns direct URLs untouched and tags progressive files with a mime type', () => {
    const r = resolveStream(findStream('bbb')!, 'direct')!
    expect(r.url).toMatch(/^https:\/\/video\.blender\.org\//)
    expect(r).toMatchObject({ protocol: 'progressive', mimeType: 'video/mp4' })
  })

  it('has no mime type for adaptive manifests', () => {
    expect(resolveStream(findStream('akamai-bbb')!, 'direct')!.mimeType).toBeUndefined()
  })

  it('returns undefined where a delivery is not offered or not configured', () => {
    expect(resolveStream(findStream('dashif-live')!, 'local')).toBeUndefined()
    expect(resolveStream(findStream('bbb')!, 'local')).toBeUndefined()
    // no VITE_CDN_BASE in tests
    expect(resolveStream(findStream('bbb')!, 'cdn-public')).toBeUndefined()
  })

  it('lists only streams available under a delivery', () => {
    expect(streamsFor('direct').every((s) => s.variants.direct)).toBe(true)
    expect(streamsFor('direct').map((s) => s.id)).toContain('bbb')
    expect(streamsFor('direct').map((s) => s.id)).not.toContain('bbb-hls')
    expect(streamsFor('local').map((s) => s.id)).toContain('bbb-hls')
    expect(streamsFor('cdn-s3')).toEqual([])
  })

  it('maps preset entries to the variant each delivery offers', () => {
    expect(pickForPreset('bbb', 'direct')?.id).toBe('bbb')
    expect(pickForPreset('bbb', 'local')?.id).toBe('bbb-hls')
    expect(pickForPreset('live', 'direct')?.id).toBe('dashif-live')
    expect(pickForPreset('live', 'local')?.id).toBe('live-llamigos')
    expect(pickForPreset('bbb', 'cdn-public')).toBeUndefined() // no CDN base configured in tests
  })

  it('has unique ids', () => {
    expect(new Set(CATALOG.map((s) => s.id)).size).toBe(CATALOG.length)
  })

  it('has attribution and license on every stream', () => {
    for (const s of CATALOG) expect(s.license && s.attribution && s.sourceUrl).toBeTruthy()
  })
})
