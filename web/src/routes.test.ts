import { describe, expect, it } from 'vitest'
import { ROUTES, routeFor } from './routes'

describe('routeFor', () => {
  it('maps each page path, with or without a trailing slash', () => {
    expect(routeFor('/')).toBe('player')
    expect(routeFor('/upload')).toBe('upload')
    expect(routeFor('/upload/')).toBe('upload')
    expect(routeFor('/analysis/')).toBe('analysis')
  })
  it('falls back to the player for unknown paths', () => {
    expect(routeFor('/nope')).toBe('player')
    expect(routeFor('/upload/extra')).toBe('player')
  })
  it('round-trips every route', () => {
    for (const r of ROUTES) expect(routeFor(r.path)).toBe(r.id)
  })
})
