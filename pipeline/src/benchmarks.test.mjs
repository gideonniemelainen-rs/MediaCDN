import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capBlob, parseRun } from './benchmarks.mjs'

const event = (over = {}) => ({ t: 1, slot: 0, streamId: 'bbb-hls', delivery: 'local', type: 'load-start', data: {}, ...over })
const run = (over = {}) => ({
  label: 'local vs s3',
  startedAt: 1_795_000_000_000,
  endedAt: 1_795_000_060_000,
  env: { userAgent: 'test' },
  timeOrigin: 1_795_000_000_000,
  nowMs: 60_000,
  sessions: [
    { slot: 0, streamId: 'bbb-hls', delivery: 'local', summary: { startupMs: 40, rebufferCount: 0, rebufferRatio: 0, avgBitrateKbps: 2932, meanSegmentLatencyMs: 8, throughputKbps: 5e5, errors: 0, extra: 'ignored' } },
  ],
  events: [event(), event({ type: 'first-frame', t: 41 })],
  ...over,
})
const rejects = (body, re, status = 400) =>
  assert.throws(() => parseRun(body), (e) => re.test(e.message) && e.status === status)

test('a good run is parsed, with unknown fields dropped', () => {
  const r = parseRun(run())
  assert.equal(r.label, 'local vs s3')
  assert.equal(r.sessions[0].startupMs, 40)
  assert.equal('extra' in r.sessions[0], false)
  assert.equal(JSON.parse(r.blob.json).events.length, 2)
  assert.equal(r.blob.downsampled, null)
})

test('the label is optional', () => {
  assert.equal(parseRun(run({ label: undefined })).label, '')
  assert.equal(parseRun(run({ label: '' })).label, '')
})

test('missing metrics become null, wrong types are refused', () => {
  const r = parseRun(run({ sessions: [{ slot: 1, streamId: 's', delivery: 'local', summary: {} }] }))
  assert.equal(r.sessions[0].startupMs, null)
  rejects(run({ sessions: [{ slot: 0, streamId: 's', delivery: 'local', summary: { startupMs: '40' } }] }), /startupMs must be a number/)
  rejects(run({ sessions: [{ slot: 0, streamId: 's', delivery: 'local', summary: { errors: 1.5 } }] }), /errors must be a whole number/)
  rejects(run({ sessions: [{ slot: 0, streamId: 's', delivery: 'local', summary: { startupMs: Infinity } }] }), /startupMs/)
})

test('sessions are bounded and must not repeat a slot', () => {
  rejects(run({ sessions: [] }), /sessions must list/)
  rejects(run({ sessions: 'x' }), /sessions must list/)
  const s = { slot: 0, streamId: 's', delivery: 'local', summary: {} }
  rejects(run({ sessions: [s, s] }), /repeat a slot/)
  rejects(run({ sessions: [{ ...s, slot: 99 }] }), /slot must be/)
  rejects(run({ sessions: [{ ...s, streamId: '' }] }), /streamId/)
})

test('times and label are checked', () => {
  rejects(run({ startedAt: 5, endedAt: 1 }), /endedAt/)
  rejects(run({ startedAt: 'now' }), /epoch milliseconds/)
  rejects(run({ label: 'x'.repeat(121) }), /label/)
  rejects(run({ label: 5 }), /label/)
})

test('events must be telemetry events and not too many', () => {
  rejects(run({ events: [{ t: 'x' }] }), /not a telemetry event/)
  rejects(run({ events: [event({ data: [] })] }), /not a telemetry event/)
  rejects(run({ events: 'nope' }), /events must be/)
  assert.throws(() => parseRun(run({ events: [event(), event()] }), { maxEvents: 1 }), /at most 1/)
  rejects(run({ timeOrigin: undefined }), /timeOrigin/)
})

test('events keep only the known fields', () => {
  const r = parseRun(run({ events: [{ ...event(), evil: '<script>' }] }))
  assert.deepEqual(Object.keys(JSON.parse(r.blob.json).events[0]).sort(), ['data', 'delivery', 'slot', 'streamId', 't', 'type'])
})

test('env must be a small object', () => {
  rejects(run({ env: 'x' }), /env must be/)
  rejects(run({ env: { big: 'x'.repeat(5000) } }), /env must be/)
})

test('a body that is not an object is refused', () => {
  rejects(null, /JSON object/)
  rejects([], /JSON object/)
})

const withSamples = (n, other = 0) => ({
  timeOrigin: 0,
  nowMs: 1,
  events: [...Array.from({ length: other }, (_, i) => event({ t: i })), ...Array.from({ length: n }, (_, i) => event({ type: 'sample', t: i, data: { pad: 'x'.repeat(100) } }))],
})

test('a blob under the cap is untouched', () => {
  const blob = withSamples(10)
  const r = capBlob(blob, 1_000_000)
  assert.equal(r.downsampled, null)
  assert.equal(JSON.parse(r.json).events.length, 10)
})

test('an oversize blob loses sample events progressively, and says so', () => {
  const blob = withSamples(400, 5)
  const full = JSON.stringify(blob).length
  const r = capBlob(blob, Math.floor(full * 0.6))
  const parsed = JSON.parse(r.json)
  const samples = parsed.events.filter((e) => e.type === 'sample').length
  assert.ok(samples < 400 && samples > 0)
  assert.deepEqual(r.downsampled, { from: 400, to: samples })
  assert.deepEqual(parsed.downsampled.sampleEvents, { from: 400, to: samples })
  assert.equal(parsed.events.filter((e) => e.type !== 'sample').length, 5, 'other events are never dropped')
  assert.ok(r.bytes <= Math.floor(full * 0.6))
})

test('samples can all go, but a blob of real events that is too big is refused', () => {
  const noSamples = capBlob(withSamples(400, 5), 2000)
  assert.equal(JSON.parse(noSamples.json).events.every((e) => e.type !== 'sample'), true)
  assert.equal(capBlob(withSamples(0, 500), 1000), null)
  assert.throws(() => parseRun(run({ events: Array.from({ length: 50 }, () => event()) }), { maxBlobBytes: 500 }), (e) => e.status === 413)
})
