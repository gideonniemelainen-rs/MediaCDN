// The settings the server holds, as this tab sees them. A plain external store (like the auth and catalog stores) read
// with useSyncExternalStore. Nothing here is required: until the server answers, and whenever it cannot, every client
// value is the build's default (the VITE_* values), which is also what a store with nothing overridden gives.
import { parseSettings, resolve, type SettingsDocument, type Values } from '@shared/settings.ts'
import { deliveryBase, setDeliveryOverrides } from '../deliveries'

const SETTINGS_URL = '/api/pipeline/settings'

export type SettingsStatus = 'loading' | 'ready' | 'unavailable'
export interface SettingsState {
  status: SettingsStatus
  /** The highest revision seen, null until the server has answered once. */
  revision: number | null
}

let state: SettingsState = { status: 'loading', revision: null }
let overrides: SettingsDocument['overrides'] = {}
let version = 0
const listeners = new Set<() => void>()

const changed = () => {
  version++
  playerCache = undefined
  listeners.forEach((l) => l())
}

export const subscribeSettings = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
/** Changes whenever what a reader of the settings would see changes. */
export const settingsVersion = () => version
export const getSettingsState = () => state

/** Forgets everything the server said and goes back to the build's defaults (tests, and signing out of a changed server). */
export function resetSettings() {
  state = { status: 'loading', revision: null }
  overrides = {}
  setDeliveryOverrides()
  changed()
}

/** Takes a settings document as the new truth. Unchanged revisions are a no-op, so polling does not re-render. */
export function applySettings(doc: SettingsDocument) {
  if (state.status === 'ready' && state.revision === doc.revision) return
  overrides = doc.overrides
  state = { status: 'ready', revision: doc.revision }
  setDeliveryOverrides(doc.overrides.deliveries)
  changed()
}

function markUnavailable() {
  if (state.status === 'unavailable') return
  // The last settings the server gave stay in force: a blip must not flip every quadrant back to the defaults.
  state = { ...state, status: 'unavailable' }
  changed()
}

let inflight: Promise<void> | undefined

/** Fetches the settings once. Callers that overlap share one request. Never throws: failure marks the settings unavailable. */
export function loadSettings(fetchFn: typeof fetch = fetch): Promise<void> {
  inflight ??= (async () => {
    try {
      const res = await fetchFn(SETTINGS_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      applySettings(parseSettings(await res.json()))
    } catch {
      markUnavailable()
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

/** Lets a refresh through at most once per `minMs`, so flicking between tabs does not hammer the server. */
export function createSyncGate(minMs: number, now: () => number = Date.now) {
  let last = -Infinity
  return () => {
    const t = now()
    if (t - last < minMs) return false
    last = t
    return true
  }
}

/** Loads the settings now and again whenever this tab comes back into view. Returns a function that stops it. */
export function startSettingsSync(minMs = 5000): () => void {
  const allowed = createSyncGate(minMs)
  const refresh = () => {
    if (document.visibilityState === 'visible' && allowed()) void loadSettings()
  }
  refresh()
  document.addEventListener('visibilitychange', refresh)
  window.addEventListener('focus', refresh)
  return () => {
    document.removeEventListener('visibilitychange', refresh)
    window.removeEventListener('focus', refresh)
  }
}

// --- the player group -------------------------------------------------------------------------------------------------

export interface PlayerSettings {
  adsEnabled: boolean
  adsBase: string
  uncappedDefault: boolean
}

const env = import.meta.env as Record<string, string | undefined>
const trim = (s: string | undefined) => s?.replace(/\/$/, '')

let playerCache: PlayerSettings | undefined

/**
 * The effective player settings. Ads come from the local origin unless told otherwise, which is the origin the
 * deliveries use, so an overridden local base moves the ads with it.
 */
export function playerSettings(): PlayerSettings {
  playerCache ??= resolve(
    'player',
    { adsEnabled: true, adsBase: trim(env.VITE_ADS_BASE) ?? deliveryBase('local') ?? 'http://localhost:8788', uncappedDefault: false } satisfies Values,
    overrides.player,
  ) as unknown as PlayerSettings
  return playerCache
}
