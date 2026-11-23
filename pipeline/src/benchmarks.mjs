// Validation of a saved benchmark run. The body comes from the browser, so every field is checked and
// copied by name; nothing from it is stored as-is except the event blob, which is size-capped.

export const MAX_BLOB_BYTES = 5_000_000
export const MAX_EVENTS = 20_000
const MAX_SESSIONS = 8
const MAX_ENV_BYTES = 4096

const bad = (message) => Object.assign(new Error(message), { status: 400 })
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const str = (v, name, max) => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw bad(`${name} must be a string of 1 to ${max} characters`)
  return v
}
const numOrNull = (v, name) => {
  if (v === null || v === undefined) return null
  if (!isNum(v)) throw bad(`${name} must be a number or null`)
  return v
}
const intOrNull = (v, name) => {
  const n = numOrNull(v, name)
  if (n !== null && !Number.isInteger(n)) throw bad(`${name} must be a whole number`)
  return n
}

/** The summary figures that are columns, so runs can be compared and sorted in SQL. */
export const METRICS = [
  ['startupMs', 'startup_ms', numOrNull],
  ['rebufferCount', 'rebuffer_count', intOrNull],
  ['rebufferRatio', 'rebuffer_ratio', numOrNull],
  ['avgBitrateKbps', 'avg_bitrate_kbps', numOrNull],
  ['meanSegmentLatencyMs', 'mean_segment_latency_ms', numOrNull],
  ['throughputKbps', 'throughput_kbps', numOrNull],
  ['errors', 'errors', intOrNull],
]

function parseSession(s, i) {
  if (!isObj(s)) throw bad(`sessions[${i}] must be an object`)
  const slot = s.slot
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SESSIONS) throw bad(`sessions[${i}].slot must be 0 to ${MAX_SESSIONS - 1}`)
  const summary = isObj(s.summary) ? s.summary : {}
  const out = {
    slot,
    streamId: str(s.streamId, `sessions[${i}].streamId`, 200),
    delivery: str(s.delivery, `sessions[${i}].delivery`, 40),
  }
  for (const [key, , check] of METRICS) out[key] = check(summary[key], `sessions[${i}].summary.${key}`)
  return out
}

function parseEvent(e, i) {
  if (!isObj(e) || !isNum(e.t) || !Number.isInteger(e.slot) || typeof e.streamId !== 'string' || typeof e.delivery !== 'string' || typeof e.type !== 'string' || !isObj(e.data)) {
    throw bad(`events[${i}] is not a telemetry event`)
  }
  return { t: e.t, slot: e.slot, streamId: e.streamId, delivery: e.delivery, type: e.type, data: e.data }
}

/**
 * Keeps the blob under `maxBytes` by thinning `sample` events (the periodic stats ticks) to every
 * 2nd, 4th, 8th, then none. Other events are never dropped: the summaries are computed from them.
 * Returns `{ json, bytes, downsampled }`, or null if it cannot fit.
 */
export function capBlob(blob, maxBytes = MAX_BLOB_BYTES) {
  const fit = (b) => {
    const text = JSON.stringify(b)
    return Buffer.byteLength(text) <= maxBytes ? text : null
  }
  const whole = fit(blob)
  if (whole) return { json: whole, bytes: Buffer.byteLength(whole), downsampled: null }
  const samples = blob.events.filter((e) => e.type === 'sample').length
  for (const keep of [2, 4, 8, Infinity]) {
    let n = 0
    const events = blob.events.filter((e) => e.type !== 'sample' || (keep !== Infinity && n++ % keep === 0))
    const kept = events.filter((e) => e.type === 'sample').length
    const text = fit({ ...blob, events, downsampled: { sampleEvents: { from: samples, to: kept } } })
    if (text) return { json: text, bytes: Buffer.byteLength(text), downsampled: { from: samples, to: kept } }
  }
  return null
}

/**
 * @returns {{ label: string, startedAt: number, endedAt: number, env: object, sessions: object[],
 *             blob: { json: string, bytes: number, downsampled: object | null } }}
 */
export function parseRun(body, { maxBlobBytes = MAX_BLOB_BYTES, maxEvents = MAX_EVENTS } = {}) {
  if (!isObj(body)) throw bad('expected a JSON object')
  const label = body.label === undefined || body.label === '' ? '' : str(body.label, 'label', 120)
  if (!isNum(body.startedAt) || !isNum(body.endedAt) || body.startedAt <= 0 || body.endedAt < body.startedAt) {
    throw bad('startedAt and endedAt must be epoch milliseconds, with endedAt not before startedAt')
  }
  const env = body.env === undefined ? {} : body.env
  if (!isObj(env) || Buffer.byteLength(JSON.stringify(env)) > MAX_ENV_BYTES) throw bad(`env must be an object under ${MAX_ENV_BYTES} bytes`)

  if (!Array.isArray(body.sessions) || body.sessions.length === 0 || body.sessions.length > MAX_SESSIONS) {
    throw bad(`sessions must list 1 to ${MAX_SESSIONS} quadrants`)
  }
  const sessions = body.sessions.map(parseSession)
  if (new Set(sessions.map((s) => s.slot)).size !== sessions.length) throw bad('sessions repeat a slot')

  if (!Array.isArray(body.events) || body.events.length > maxEvents) throw bad(`events must be a list of at most ${maxEvents}`)
  if (!isNum(body.timeOrigin) || !isNum(body.nowMs)) throw bad('timeOrigin and nowMs are required numbers')
  const events = body.events.map(parseEvent)

  const blob = capBlob({ timeOrigin: body.timeOrigin, nowMs: body.nowMs, events }, maxBlobBytes)
  if (!blob) throw Object.assign(new Error('the telemetry is too large to store'), { status: 413 })
  return { label, startedAt: Math.round(body.startedAt), endedAt: Math.round(body.endedAt), env, sessions, blob }
}
