import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BASED_DELIVERIES, DELIVERIES, DELIVERY, INDEXED_DELIVERIES, TRANSPORTS, TRANSPORT_VAR, isDelivery, isIndexed, isTransport } from './deliveries.ts'

test('every delivery has a record under its own id, in picker order', () => {
  assert.deepEqual(DELIVERIES, ['direct', 'local', 's3-near', 's3-far', 'cdn-public', 'cdn-s3'])
  for (const d of DELIVERIES) assert.equal(DELIVERY[d].id, d)
  assert.deepEqual(Object.keys(DELIVERY), [...DELIVERIES])
})

test('labels are the ones the picker and stats show', () => {
  assert.deepEqual(DELIVERIES.map((d) => DELIVERY[d].label), ['Direct (public)', 'Origin (local)', 'S3 near', 'S3 far', 'Media CDN → public', 'Media CDN → S3'])
})

test('the four deliveries that serve our own titles are indexed, with the prefixes their routes use', () => {
  assert.deepEqual(INDEXED_DELIVERIES, ['local', 's3-near', 's3-far', 'cdn-s3'])
  assert.deepEqual(INDEXED_DELIVERIES.map((d) => DELIVERY[d].indexPrefix), ['', '', '', '/s3'])
  assert.equal(isIndexed('cdn-public'), false)
  assert.equal(isIndexed('direct'), false)
  assert.equal(isIndexed('cdn-s3'), true)
})

test('base URLs come from the variables the README documents, and only the local origin has a default', () => {
  assert.deepEqual(DELIVERY.local.baseVars, ['VITE_LOCAL_BASE'])
  assert.deepEqual(DELIVERY['s3-near'].baseVars, ['VITE_S3_NEAR_BASE', 'VITE_S3_BASE'])
  assert.deepEqual(DELIVERY['s3-far'].baseVars, ['VITE_S3_FAR_BASE'])
  assert.deepEqual(DELIVERY['cdn-public'].baseVars, ['VITE_CDN_BASE'])
  assert.deepEqual(DELIVERY['cdn-s3'].baseVars, ['VITE_CDN_BASE'])
  assert.deepEqual(DELIVERY.direct.baseVars, [])
  assert.deepEqual(DELIVERIES.filter((d) => DELIVERY[d].defaultBase !== null), ['local'])
  assert.equal(DELIVERY.local.defaultBase, 'http://localhost:8788')
})

test('every delivery but direct has a base to configure', () => {
  assert.deepEqual(BASED_DELIVERIES, ['local', 's3-near', 's3-far', 'cdn-public', 'cdn-s3'])
})

test('the transport lab listeners have their own variables', () => {
  assert.deepEqual(TRANSPORTS, ['h1', 'h2', 'h3'])
  assert.deepEqual(TRANSPORTS.map((t) => TRANSPORT_VAR[t]), ['VITE_LOCAL_BASE_H1', 'VITE_LOCAL_BASE_H2', 'VITE_LOCAL_BASE_H3'])
})

test('guards accept only known ids', () => {
  assert.equal(isDelivery('local'), true)
  for (const bad of ['', 'LOCAL', 's3', 'toString', null, undefined, 3]) assert.equal(isDelivery(bad), false, String(bad))
  assert.equal(isTransport('h3'), true)
  for (const bad of ['h4', 'H1', '', null, 'constructor']) assert.equal(isTransport(bad), false, String(bad))
})
