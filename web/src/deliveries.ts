import {
  BASED_DELIVERIES, DELIVERIES, DELIVERY, INDEXED_DELIVERIES, TRANSPORTS, TRANSPORT_VAR, isIndexed,
  type Delivery, type Transport,
} from '@shared/deliveries.ts'
import { indexLocation } from '@shared/title-layout.ts'
import { resolve, type Values } from '@shared/settings.ts'

export { DELIVERIES, INDEXED_DELIVERIES, TRANSPORTS, isIndexed }
export type { Delivery, Transport }

/**
 * How bytes reach the player:
 *  direct     public third-party URL, no CDN
 *  local      our own packaged origin on this machine
 *  s3-near    our S3 bucket read directly (no CDN), the one close to the viewer
 *  s3-far     the same content in a bucket far from the viewer, to show what distance costs
 *  cdn-public Media CDN in front of a public third-party origin
 *  cdn-s3     Media CDN in front of our private S3 bucket
 *
 * `local`, `s3-near`, `s3-far` and `cdn-s3` serve our own packaged titles, which are discovered at
 * runtime from each origin's index.json. `direct` and `cdn-public` use the built-in list of public
 * streams. Each quadrant picks its own delivery, so one title can be compared across several.
 */

/** Names for the picker and the on-screen stats. The ids stay as they are in exports. */
export const DELIVERY_LABEL: Record<Delivery, string> = Object.fromEntries(DELIVERIES.map((d) => [d, DELIVERY[d].label])) as Record<Delivery, string>

// --- the effective table: what the build says, with what the settings override on top ----------------------------------

const env = import.meta.env as Record<string, string | undefined>
const trim = (s: string | undefined) => s?.replace(/\/$/, '')

/** The base URL the build gives a delivery: the first of its variables that is set, else its built-in default. */
function envBase(delivery: Delivery): string | undefined {
  const info = DELIVERY[delivery]
  for (const name of info.baseVars) {
    const v = trim(env[name])
    if (v !== undefined) return v
  }
  return info.defaultBase ?? undefined
}

/** Every delivery is on, with the bases the build gives; the settings can then override either. */
function envDefaults(): Values {
  const values: Values = {}
  for (const d of DELIVERIES) {
    values[`${d}.enabled`] = true
    const base = BASED_DELIVERIES.includes(d) ? envBase(d) : undefined
    if (base !== undefined) values[`${d}.base`] = base
  }
  for (const t of TRANSPORTS) {
    const v = trim(env[TRANSPORT_VAR[t]])
    if (v !== undefined) values[`local.base${t.toUpperCase()}`] = v
  }
  return values
}

const DEFAULTS = envDefaults()
let effective: Values = DEFAULTS
let version = 0
const listeners = new Set<() => void>()

/**
 * Applies the stored overrides of the `deliveries` settings group over the build's defaults. Unknown or invalid
 * values are ignored (see `resolve`). Call with nothing to go back to the defaults.
 */
export function setDeliveryOverrides(overrides?: Values) {
  effective = resolve('deliveries', DEFAULTS, overrides)
  version++
  listeners.forEach((l) => l())
}

/** Changes whenever the table does (a base or an enabled flag), for a hook that must react to it. */
export const deliveriesVersion = () => version

export const subscribeDeliveries = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** False when the settings have switched the delivery off. A disabled delivery is hidden from pickers. */
export const isEnabled = (delivery: Delivery): boolean => effective[`${delivery}.enabled`] !== false

/** The base URL of a delivery, or undefined when it has none (`direct`) or none is configured. An empty one means unset. */
export const deliveryBase = (delivery: Delivery): string | undefined => {
  const v = effective[`${delivery}.base`]
  return typeof v === 'string' ? v : undefined
}

/** The local origin behind one of the transport lab's listeners. Unset means that transport is not available. */
export const transportBase = (transport: Transport): string | undefined => {
  const v = effective[`local.base${transport.toUpperCase()}`]
  return typeof v === 'string' ? v : undefined
}

/** The `VITE_*` variable that names a delivery's base URL, for "set …" messages. */
export const baseVarOf = (delivery: Delivery): string | undefined => DELIVERY[delivery].baseVars[0]

/** Path prefix a delivery's index and media live under, or null when its titles do not come from an index. */
export const indexPrefix = (delivery: Delivery): string | null => DELIVERY[delivery].indexPrefix

export function indexUrl(delivery: Delivery): string | undefined {
  const base = deliveryBase(delivery)
  const prefix = indexPrefix(delivery)
  return base && prefix !== null ? indexLocation(base, prefix) : undefined
}

/** Why a requested transport cannot be used, or undefined when it can (or none was requested). */
export function transportProblem(delivery: Delivery, transport: Transport | null | undefined): string | undefined {
  if (!transport || delivery !== 'local') return undefined
  return transportBase(transport) ? undefined : `Set ${TRANSPORT_VAR[transport]} to play over ${transport} (see infra/local/README.md)`
}
