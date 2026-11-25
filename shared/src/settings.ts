// The Settings schema: what the GUI can change, grouped, with one validator that every end uses (the API on write, the
// forms for inline errors, the clients when they read). Pure, so it needs no server or database to test.
//
// Settings are stored as overrides: only the fields someone has set. Each client merges them over its own defaults
// (the web app over its VITE_* values, the pipeline over PIPELINE_PACKAGER and PIPELINE_IMAGE, the origin over its
// constants), so an empty store changes nothing. Boot-time values (ports, DATABASE_URL) are not settings.
// Settings never hold secrets: credentials come from the host (the AWS profile) and are never stored.
import { BASED_DELIVERIES, DELIVERIES, DELIVERY, TRANSPORTS } from './deliveries.ts'

export type GroupName = 'deliveries' | 'packaging' | 'player' | 'origin'
export type Value = boolean | string | number
/** One group's fields by key: an override, a default, or the effective result of merging them. */
export type Values = Record<string, Value>

export type FieldType =
  | { kind: 'boolean' }
  | { kind: 'url' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'text'; pattern: RegExp; hint: string }

export interface Field {
  key: string
  label: string
  help: string
  type: FieldType
}

export interface Group {
  label: string
  fields: readonly Field[]
}

const bool = (key: string, label: string, help: string): Field => ({ key, label, help, type: { kind: 'boolean' } })
const url = (key: string, label: string, help: string): Field => ({ key, label, help, type: { kind: 'url' } })

const deliveryFields: Field[] = [
  ...DELIVERIES.flatMap((d) => {
    const { label } = DELIVERY[d]
    const enabled = bool(`${d}.enabled`, `${label}: enabled`, 'Off hides it from the pickers; a quadrant already using it says it is disabled in settings.')
    return BASED_DELIVERIES.includes(d) ? [enabled, url(`${d}.base`, `${label}: base URL`, 'Where this delivery is served from, without a trailing slash.')] : [enabled]
  }),
  ...TRANSPORTS.map((t) => url(`local.base${t.toUpperCase()}`, `Origin (local) over ${t}: base URL`, 'The transport lab listener for this HTTP version (see infra/local/README.md).')),
]

export const GROUPS: Readonly<Record<GroupName, Group>> = {
  deliveries: { label: 'Deliveries', fields: deliveryFields },
  packaging: {
    label: 'Packaging',
    fields: [
      { key: 'packager', label: 'Packager', help: 'ffmpeg runs on the host; shaka runs Shaka Packager in the worker image (needs Docker).', type: { kind: 'enum', values: ['ffmpeg', 'shaka'] } },
      {
        key: 'image',
        label: 'Worker image',
        help: 'The Docker image the shaka packager runs in.',
        // Passed to `docker run` as an argument, so it may not start with a dash or hold anything but an image reference.
        type: { kind: 'text', pattern: /^[a-z0-9][a-z0-9._/:@-]{0,199}$/, hint: 'a Docker image reference such as mediacdn-pipeline:dev' },
      },
      { key: 'ladderCrf', label: 'Ladder constant quality (CRF)', help: 'Lower is better quality and larger files. Used by the content-aware ladder.', type: { kind: 'int', min: 10, max: 35 } },
    ],
  },
  player: {
    label: 'Player',
    fields: [
      bool('adsEnabled', 'Ads', 'Off hides the ad button.'),
      url('adsBase', 'Ads base URL', 'Where the ad inventory (ads.json) and clips are served from.'),
      bool('uncappedDefault', 'Start uncapped', 'Start with the 360p cap on unfocused quadrants lifted.'),
    ],
  },
  origin: {
    label: 'Origin',
    fields: [
      bool('liveEnabled', 'Simulated live', 'Off stops the origin serving /live/<id>/.'),
      { key: 'liveWindow', label: 'Live window (segments)', help: 'How many segments the simulated live playlist lists.', type: { kind: 'int', min: 2, max: 30 } },
    ],
  },
}

export const GROUP_NAMES = Object.keys(GROUPS) as GroupName[]
export const isGroupName = (value: unknown): value is GroupName => typeof value === 'string' && Object.hasOwn(GROUPS, value)

const FIELDS: Readonly<Record<GroupName, ReadonlyMap<string, Field>>> = Object.fromEntries(
  GROUP_NAMES.map((g) => [g, new Map(GROUPS[g].fields.map((f) => [f.key, f]))]),
) as unknown as Record<GroupName, ReadonlyMap<string, Field>>

export const fieldOf = (group: GroupName, key: string): Field | undefined => FIELDS[group].get(key)

// --- validation ----------------------------------------------------------------------------------

export type FieldResult = { ok: true; value: Value } | { ok: false; error: string }

/** Checks one value against its field and returns it in its stored form (URLs without a trailing slash, text trimmed). */
export function validateField(field: Field, value: unknown): FieldResult {
  const t = field.type
  switch (t.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'must be true or false' }
    case 'enum':
      return typeof value === 'string' && t.values.includes(value) ? { ok: true, value } : { ok: false, error: `must be one of ${t.values.join(', ')}` }
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= t.min && value <= t.max
        ? { ok: true, value }
        : { ok: false, error: `must be a whole number from ${t.min} to ${t.max}` }
    case 'text': {
      const text = typeof value === 'string' ? value.trim() : ''
      return t.pattern.test(text) ? { ok: true, value: text } : { ok: false, error: `must be ${t.hint}` }
    }
    case 'url': {
      const bad = { ok: false, error: 'must be an http(s) URL without credentials, a query or a fragment' } as const
      if (typeof value !== 'string' || value.length > 2048) return bad
      const text = value.trim()
      let u: URL
      try {
        u = new URL(text)
      } catch {
        return bad
      }
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) return bad
      return { ok: true, value: text.replace(/\/+$/, '') }
    }
  }
}

export type GroupResult = { ok: true; value: Values } | { ok: false; errors: Record<string, string> }

/** Validates a group's overrides as sent to the API: a plain object of known fields with valid values. */
export function validateGroup(group: GroupName, input: unknown): GroupResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: { '': 'must be an object of settings' } }
  const value: Values = {}
  // Entries, not an object being assigned into: `errors['__proto__'] = '…'` would hit the prototype setter and vanish.
  const errors: [string, string][] = []
  for (const [key, raw] of Object.entries(input)) {
    const field = fieldOf(group, key)
    if (!field) {
      errors.push([key, 'unknown setting'])
      continue
    }
    const r = validateField(field, raw)
    if (r.ok) value[key] = r.value
    else errors.push([key, r.error])
  }
  return errors.length ? { ok: false, errors: Object.fromEntries(errors) } : { ok: true, value }
}

// --- merging and reading -------------------------------------------------------------------------

/**
 * The effective values of a group: `defaults`, with each valid override on top. An override that is unknown or no
 * longer valid (the schema moved on since it was stored) is ignored rather than breaking the client.
 */
export function resolve(group: GroupName, defaults: Values, overrides?: Values): Values {
  const out: Values = { ...defaults }
  for (const [key, raw] of Object.entries(overrides ?? {})) {
    const field = fieldOf(group, key)
    const r = field && validateField(field, raw)
    if (r?.ok) out[key] = r.value
  }
  return out
}

/**
 * What `GET /settings` returns: the highest revision stored, each group's overrides, and each group's own revision
 * (what a write to that group is checked against with `If-Match`; a group never set has none).
 */
export interface SettingsDocument {
  revision: number
  overrides: Partial<Record<GroupName, Values>>
  revisions: Partial<Record<GroupName, number>>
}

/**
 * Reads a `GET /settings` body on the client side. A wrong shape throws; within it, unknown groups, unknown fields and
 * invalid values are dropped, so a newer or older server never breaks an older or newer client.
 */
export function parseSettings(json: unknown): SettingsDocument {
  const j = json as { revision?: unknown; overrides?: unknown; revisions?: unknown } | null
  if (!j || typeof j.revision !== 'number' || !Number.isFinite(j.revision) || typeof j.overrides !== 'object' || j.overrides === null || Array.isArray(j.overrides)) {
    throw new Error('not a settings document (expected revision and overrides)')
  }
  const overrides: SettingsDocument['overrides'] = {}
  for (const [name, group] of Object.entries(j.overrides)) {
    if (!isGroupName(name) || typeof group !== 'object' || group === null || Array.isArray(group)) continue
    const kept = resolve(name, {}, group as Values)
    if (Object.keys(kept).length) overrides[name] = kept
  }
  const revisions: SettingsDocument['revisions'] = {}
  if (typeof j.revisions === 'object' && j.revisions !== null && !Array.isArray(j.revisions)) {
    for (const [name, n] of Object.entries(j.revisions)) if (isGroupName(name) && typeof n === 'number' && Number.isInteger(n) && n >= 0) revisions[name] = n
  }
  return { revision: j.revision, overrides, revisions }
}
