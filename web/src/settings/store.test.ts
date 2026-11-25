import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliveryBase, isEnabled } from '../deliveries'
import { applySettings, createSyncGate, getSettingsState, loadSettings, playerSettings, resetSettings, settingsVersion } from './store'

afterEach(() => {
  resetSettings()
  vi.unstubAllEnvs()
})

const doc = (revision: number, overrides: Parameters<typeof applySettings>[0]['overrides'] = {}) => ({ revision, overrides, revisions: {} })
const reply = (body: unknown, init?: ResponseInit) => vi.fn(async () => new Response(JSON.stringify(body), init))

describe('before the server answers', () => {
  it('is loading, with the build as it was: every delivery on, the local origin at its default', () => {
    expect(getSettingsState()).toEqual({ status: 'loading', revision: null })
    expect(isEnabled('s3-near')).toBe(true)
    expect(deliveryBase('local')).toBe('http://localhost:8788')
  })

  it('has the player defaults', () => {
    expect(playerSettings()).toMatchObject({ adsEnabled: true, uncappedDefault: false })
  })
})

describe('loadSettings', () => {
  it('applies what the server holds and says it is ready', async () => {
    const fetchFn = reply({
      revision: 4,
      overrides: { deliveries: { 's3-near.base': 'https://near.example.com/', 'local.enabled': false }, player: { adsEnabled: false, uncappedDefault: true } },
      revisions: { deliveries: 4 },
    })
    await loadSettings(fetchFn)
    expect(fetchFn).toHaveBeenCalledWith('/api/pipeline/settings', { cache: 'no-store' })
    expect(getSettingsState()).toEqual({ status: 'ready', revision: 4 })
    expect(deliveryBase('s3-near')).toBe('https://near.example.com')
    expect(isEnabled('local')).toBe(false)
    expect(playerSettings()).toMatchObject({ adsEnabled: false, uncappedDefault: true })
  })

  it('shares one request between callers that overlap', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchFn = vi.fn(async () => {
      await gate
      return new Response(JSON.stringify(doc(1)))
    })
    const a = loadSettings(fetchFn)
    const b = loadSettings(fetchFn)
    release()
    await Promise.all([a, b])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the network is down', vi.fn(async () => Promise.reject(new TypeError('failed to fetch')))],
    ['the server errors', reply({}, { status: 500 })],
    ['the answer is not JSON', vi.fn(async () => new Response('<html>', { status: 200 }))],
    ['the answer is not a settings document', reply({ hello: 'world' })],
  ])('falls back to the defaults, and says so, when %s', async (_why, fetchFn) => {
    await loadSettings(fetchFn)
    expect(getSettingsState().status).toBe('unavailable')
    expect(deliveryBase('local')).toBe('http://localhost:8788')
    expect(isEnabled('local')).toBe(true)
  })

  it('keeps the last settings it had when the server goes away, and recovers when it is back', async () => {
    await loadSettings(reply(doc(2, { deliveries: { 'local.enabled': false } })))
    await loadSettings(vi.fn(async () => Promise.reject(new TypeError('down'))))
    expect(getSettingsState()).toEqual({ status: 'unavailable', revision: 2 })
    expect(isEnabled('local')).toBe(false)
    await loadSettings(reply(doc(3, {})))
    expect(getSettingsState()).toEqual({ status: 'ready', revision: 3 })
    expect(isEnabled('local')).toBe(true)
  })

  it('ignores settings it does not understand instead of breaking', async () => {
    await loadSettings(reply({ revision: 1, overrides: { deliveries: { 'local.base': 'not a url', 'mystery.enabled': true }, retired: { a: 1 }, player: { adsEnabled: 'no' } } }))
    expect(getSettingsState().status).toBe('ready')
    expect(deliveryBase('local')).toBe('http://localhost:8788')
    expect(playerSettings().adsEnabled).toBe(true)
  })

  it('does not stir anything when the revision has not moved', async () => {
    await loadSettings(reply(doc(5, { deliveries: { 'local.enabled': false } })))
    const before = settingsVersion()
    await loadSettings(reply(doc(5, { deliveries: { 'local.enabled': false } })))
    expect(settingsVersion()).toBe(before)
    await loadSettings(reply(doc(6, {})))
    expect(settingsVersion()).toBeGreaterThan(before)
  })

  it('goes back to the build when reset', async () => {
    await loadSettings(reply(doc(1, { deliveries: { 'local.base': 'http://other.example:9000' }, player: { adsEnabled: false } })))
    resetSettings()
    expect(deliveryBase('local')).toBe('http://localhost:8788')
    expect(playerSettings().adsEnabled).toBe(true)
    expect(getSettingsState()).toEqual({ status: 'loading', revision: null })
  })
})

describe('the ads base', () => {
  it('is an override first, then VITE_ADS_BASE, then the local origin', async () => {
    applySettings(doc(1, { player: { adsBase: 'https://ads.example.com/' } }))
    expect(playerSettings().adsBase).toBe('https://ads.example.com')

    resetSettings()
    vi.stubEnv('VITE_ADS_BASE', undefined as unknown as string)
    vi.resetModules()
    const fresh = await import('./store')
    const deliveries = await import('../deliveries')
    expect(fresh.playerSettings().adsBase).toBe(deliveries.deliveryBase('local'))
    deliveries.setDeliveryOverrides({ 'local.base': 'http://localhost:9999' })
    fresh.applySettings(doc(2, { deliveries: { 'local.base': 'http://localhost:9999' } }))
    expect(fresh.playerSettings().adsBase).toBe('http://localhost:9999')
  })
})

describe('createSyncGate', () => {
  it('lets one refresh through per interval', () => {
    let t = 1000
    const allowed = createSyncGate(5000, () => t)
    expect(allowed()).toBe(true)
    t += 4999
    expect(allowed()).toBe(false)
    t += 1
    expect(allowed()).toBe(true)
    expect(allowed()).toBe(false)
  })
})
