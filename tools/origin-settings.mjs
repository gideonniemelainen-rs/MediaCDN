// The origin's view of the `origin` settings group. It asks the pipeline API (GET /settings, public) and caches the
// answer for `ttlMs`; if the API cannot be reached it keeps the last values it had, and before any answer it uses the
// defaults, so the origin never depends on the pipeline being up. Failed attempts are also cached for `ttlMs`, so a
// down API costs one short request per interval, not one per segment.
import { parseSettings, resolve } from '../shared/src/settings.ts'
import { DEFAULT_LIVE_WINDOW } from './live.mjs'

export const ORIGIN_DEFAULTS = { liveEnabled: true, liveWindow: DEFAULT_LIVE_WINDOW }

/**
 * @param {object} o
 * @param {string} o.url        the pipeline API, e.g. http://127.0.0.1:8790/api/pipeline
 * @param {typeof fetch} [o.fetchFn]
 * @param {() => number} [o.now]
 * @param {(msg: string) => void} [o.warn]
 */
export function createOriginSettings({ url, fetchFn = fetch, ttlMs = 5000, timeoutMs = 2000, now = Date.now, warn = () => {} }) {
  let current = { ...ORIGIN_DEFAULTS }
  let checkedAt = -Infinity
  let inflight = null
  let failing = false

  async function refresh() {
    try {
      const res = await fetchFn(`${url}/settings`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const doc = parseSettings(await res.json())
      current = resolve('origin', ORIGIN_DEFAULTS, doc.overrides.origin)
      if (failing) warn('settings are reachable again')
      failing = false
    } catch (e) {
      if (!failing) warn(`settings unavailable (${e.message}); keeping the last values`)
      failing = true
    } finally {
      checkedAt = now()
      inflight = null
    }
  }

  return {
    /** The effective settings: fresh enough, or the last known. */
    async get() {
      if (now() - checkedAt >= ttlMs) await (inflight ??= refresh())
      return current
    },
  }
}
