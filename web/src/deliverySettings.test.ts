// The effective delivery table: the build's VITE_* values (pinned in vite.config.ts), with settings overrides on top.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { baseVarOf, deliveryBase, indexPrefix, indexUrl, isEnabled, setDeliveryOverrides, subscribeDeliveries, transportBase, transportProblem } from './deliveries'

afterEach(() => setDeliveryOverrides())

describe('with nothing overridden', () => {
  it('is the build: the local origin has its default, the others are unset in tests, direct has no base', () => {
    expect(deliveryBase('local')).toBe('http://localhost:8788')
    expect(deliveryBase('s3-near')).toBe('')
    expect(deliveryBase('cdn-s3')).toBe('')
    expect(deliveryBase('direct')).toBeUndefined()
  })

  it('has every delivery enabled', () => {
    for (const d of ['direct', 'local', 's3-near', 's3-far', 'cdn-public', 'cdn-s3'] as const) expect(isEnabled(d)).toBe(true)
  })

  it('builds an index URL only for an indexed delivery that has a base', () => {
    expect(indexUrl('local')).toBe('http://localhost:8788/index.json')
    expect(indexUrl('s3-near')).toBeUndefined()
    expect(indexUrl('direct')).toBeUndefined()
    expect(indexUrl('cdn-public')).toBeUndefined()
  })

  it('names the variable to set, and the prefix an index lives under', () => {
    expect(baseVarOf('s3-near')).toBe('VITE_S3_NEAR_BASE')
    expect(baseVarOf('cdn-s3')).toBe('VITE_CDN_BASE')
    expect(baseVarOf('direct')).toBeUndefined()
    expect(indexPrefix('cdn-s3')).toBe('/s3')
    expect(indexPrefix('direct')).toBeNull()
  })
})

describe('with settings overrides', () => {
  it('uses an overridden base, and builds the index URL from it', () => {
    setDeliveryOverrides({ 's3-near.base': 'https://near.example.com/' })
    expect(deliveryBase('s3-near')).toBe('https://near.example.com')
    expect(indexUrl('s3-near')).toBe('https://near.example.com/index.json')
    expect(deliveryBase('local')).toBe('http://localhost:8788')
  })

  it('puts the index of the CDN-over-S3 delivery under its prefix', () => {
    setDeliveryOverrides({ 'cdn-s3.base': 'https://cdn.example.com' })
    expect(indexUrl('cdn-s3')).toBe('https://cdn.example.com/s3/index.json')
  })

  it('switches a delivery off without touching its base', () => {
    setDeliveryOverrides({ 'local.enabled': false })
    expect(isEnabled('local')).toBe(false)
    expect(deliveryBase('local')).toBe('http://localhost:8788')
    expect(isEnabled('s3-near')).toBe(true)
  })

  it('applies a transport listener override, and stops reporting that transport as unavailable', () => {
    expect(transportBase('h3')).toBeFalsy() // pinned empty in tests: set but blank means unset
    expect(transportProblem('local', 'h3')).toMatch(/VITE_LOCAL_BASE_H3/)
    setDeliveryOverrides({ 'local.baseH3': 'https://localhost:8443' })
    expect(transportBase('h3')).toBe('https://localhost:8443')
    expect(transportProblem('local', 'h3')).toBeUndefined()
  })

  it('ignores unknown and invalid overrides instead of breaking', () => {
    setDeliveryOverrides({ 'local.base': 'not a url', 'local.enabled': 'no', 'mystery.base': 'http://x.example' })
    expect(deliveryBase('local')).toBe('http://localhost:8788')
    expect(isEnabled('local')).toBe(true)
  })

  it('goes back to the build when called with nothing', () => {
    setDeliveryOverrides({ 'local.base': 'http://other.example:9000', 'local.enabled': false })
    setDeliveryOverrides()
    expect(deliveryBase('local')).toBe('http://localhost:8788')
    expect(isEnabled('local')).toBe(true)
  })

  it('tells subscribers when the table changes, until they unsubscribe', () => {
    const listener = vi.fn()
    const off = subscribeDeliveries(listener)
    setDeliveryOverrides({ 'local.enabled': false })
    setDeliveryOverrides()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    setDeliveryOverrides({ 'local.enabled': false })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
