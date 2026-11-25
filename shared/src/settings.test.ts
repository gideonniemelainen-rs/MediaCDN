import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DELIVERIES } from './deliveries.ts'
import { GROUPS, GROUP_NAMES, fieldOf, isGroupName, parseSettings, resolve, validateField, validateGroup } from './settings.ts'

const field = (group: Parameters<typeof fieldOf>[0], key: string) => {
  const f = fieldOf(group, key)
  assert.ok(f, `${group}.${key} exists`)
  return f
}

test('there are four groups, and every field key is unique within its group', () => {
  assert.deepEqual(GROUP_NAMES, ['deliveries', 'packaging', 'player', 'origin'])
  for (const g of GROUP_NAMES) {
    const keys = GROUPS[g].fields.map((f) => f.key)
    assert.equal(new Set(keys).size, keys.length, g)
  }
})

test('every delivery can be switched off, and every one but direct has a base URL', () => {
  const keys = GROUPS.deliveries.fields.map((f) => f.key)
  for (const d of DELIVERIES) assert.ok(keys.includes(`${d}.enabled`), `${d}.enabled`)
  assert.ok(!keys.includes('direct.base'), 'direct has no base')
  for (const d of DELIVERIES.filter((x) => x !== 'direct')) assert.ok(keys.includes(`${d}.base`), `${d}.base`)
  for (const k of ['local.baseH1', 'local.baseH2', 'local.baseH3']) assert.ok(keys.includes(k), k)
})

test('group names are only the known ones', () => {
  assert.equal(isGroupName('player'), true)
  for (const bad of ['', 'Player', 'toString', '__proto__', null, 7]) assert.equal(isGroupName(bad), false, String(bad))
})

test('booleans, enums and whole numbers accept their own kind and nothing else', () => {
  assert.deepEqual(validateField(field('player', 'adsEnabled'), true), { ok: true, value: true })
  for (const bad of ['true', 1, null, undefined]) assert.equal(validateField(field('player', 'adsEnabled'), bad).ok, false, String(bad))

  assert.deepEqual(validateField(field('packaging', 'packager'), 'shaka'), { ok: true, value: 'shaka' })
  for (const bad of ['shakka', '', 'FFMPEG', 3]) assert.equal(validateField(field('packaging', 'packager'), bad).ok, false, String(bad))

  assert.deepEqual(validateField(field('origin', 'liveWindow'), 5), { ok: true, value: 5 })
  for (const bad of [1, 31, 2.5, '5', NaN, Infinity]) assert.equal(validateField(field('origin', 'liveWindow'), bad).ok, false, String(bad))
})

test('a base URL is an http(s) URL, stored without a trailing slash and without surrounding space', () => {
  const f = field('deliveries', 'local.base')
  assert.deepEqual(validateField(f, 'http://localhost:8788/'), { ok: true, value: 'http://localhost:8788' })
  assert.deepEqual(validateField(f, '  https://cdn.example.com/s3//  '), { ok: true, value: 'https://cdn.example.com/s3' })
  for (const bad of ['', 'localhost:8788', 'ftp://x.example', 'javascript:alert(1)', 'http://user:pw@x.example', 'http://x.example/?a=1', 'http://x.example/#f', 'not a url', 42, null]) {
    assert.equal(validateField(f, bad).ok, false, String(bad))
  }
  assert.equal(validateField(f, 'http://x.example/' + 'a'.repeat(2100)).ok, false, 'over-long')
})

test('the worker image is a plain image reference that cannot be mistaken for a docker option', () => {
  const f = field('packaging', 'image')
  for (const ok of ['mediacdn-pipeline:dev', 'registry.example.com:5000/team/worker:1.2', 'worker@sha256:abc123']) assert.equal(validateField(f, ok).ok, true, ok)
  for (const bad of ['', '-v /:/host', '--privileged', 'a b', 'img;rm', 'Upper', 'x'.repeat(201), 5]) assert.equal(validateField(f, bad).ok, false, String(bad))
  assert.deepEqual(validateField(f, '  worker:1 '), { ok: true, value: 'worker:1' })
})

test('validateGroup returns the stored form of every field, or every error at once', () => {
  assert.deepEqual(validateGroup('packaging', { packager: 'shaka', ladderCrf: 23 }), { ok: true, value: { packager: 'shaka', ladderCrf: 23 } })
  assert.deepEqual(validateGroup('player', {}), { ok: true, value: {} })
  const bad = validateGroup('packaging', { packager: 'x', ladderCrf: 'high', nope: 1 })
  assert.equal(bad.ok, false)
  assert.deepEqual(Object.keys(bad.ok ? {} : bad.errors).sort(), ['ladderCrf', 'nope', 'packager'])
  assert.equal(bad.ok ? '' : bad.errors.nope, 'unknown setting')
})

test('validateGroup refuses anything that is not a plain object', () => {
  for (const bad of [null, undefined, 'x', 3, [], [{ packager: 'ffmpeg' }]]) assert.equal(validateGroup('packaging', bad).ok, false, JSON.stringify(bad))
})

test('keys that would reach an object prototype are unknown settings, not applied', () => {
  const r = validateGroup('player', JSON.parse('{"__proto__": {"adsEnabled": true}, "constructor": 1}'))
  assert.equal(r.ok, false)
  assert.deepEqual(Object.keys(r.ok ? {} : r.errors).sort(), ['__proto__', 'constructor'])
  assert.equal(({} as Record<string, unknown>).adsEnabled, undefined, 'the global prototype is untouched')
})

test('resolve puts valid overrides over the defaults and ignores unknown or invalid ones', () => {
  const defaults = { packager: 'ffmpeg', image: 'mediacdn-pipeline:dev', ladderCrf: 21 }
  assert.deepEqual(resolve('packaging', defaults), defaults)
  assert.deepEqual(resolve('packaging', defaults, {}), defaults)
  assert.deepEqual(resolve('packaging', defaults, { packager: 'shaka' }), { ...defaults, packager: 'shaka' })
  // A stored value the schema no longer accepts falls back to the default rather than breaking the client.
  assert.deepEqual(resolve('packaging', defaults, { packager: 'retired', ladderCrf: 99, gone: true }), defaults)
  assert.deepEqual(resolve('packaging', defaults, { image: '  worker:2 ' }), { ...defaults, image: 'worker:2' })
})

test('resolve does not change what it is given', () => {
  const defaults = { liveEnabled: true, liveWindow: 5 }
  const overrides = { liveWindow: 8 }
  resolve('origin', defaults, overrides)
  assert.deepEqual(defaults, { liveEnabled: true, liveWindow: 5 })
  assert.deepEqual(overrides, { liveWindow: 8 })
})

test('parseSettings reads a document and drops what it cannot use', () => {
  const doc = parseSettings({
    revision: 7,
    overrides: {
      player: { adsEnabled: false, adsBase: 'http://localhost:8788/', mystery: 1, uncappedDefault: 'yes' },
      origin: { liveWindow: 9 },
      retired: { a: 1 },
      deliveries: [],
      packaging: { nope: true },
    },
  })
  assert.equal(doc.revision, 7)
  assert.deepEqual(doc.overrides, { player: { adsEnabled: false, adsBase: 'http://localhost:8788' }, origin: { liveWindow: 9 } })
})

test('parseSettings refuses a body that is not a settings document', () => {
  for (const bad of [null, 'x', {}, { revision: 'a', overrides: {} }, { revision: 1 }, { revision: 1, overrides: null }, { revision: 1, overrides: [] }, { revision: NaN, overrides: {} }]) {
    assert.throws(() => parseSettings(bad), /not a settings document/, JSON.stringify(bad))
  }
  assert.deepEqual(parseSettings({ revision: 0, overrides: {} }), { revision: 0, overrides: {} })
})
