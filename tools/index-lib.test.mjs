import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildIndex } from './index-lib.mjs'

const NOW = new Date('2026-01-01T00:00:00Z')

test('lists titles with the protocols they have, sorted by id', () => {
  const idx = buildIndex(
    [
      { slug: 'bbb', files: ['master.m3u8', 'manifest.mpd', 'media_0.m3u8'] },
      { slug: 'agent-327', files: ['master.m3u8'] },
      { slug: 'dash-only', files: ['manifest.mpd'] },
    ],
    { now: NOW },
  )
  assert.equal(idx.version, 1)
  assert.equal(idx.generatedAt, NOW.toISOString())
  assert.deepEqual(idx.titles, [
    { id: 'agent-327', protocols: ['hls'] },
    { id: 'bbb', protocols: ['hls', 'dash'] },
    { id: 'dash-only', protocols: ['dash'] },
  ])
})

test('skips folders without a manifest and ids that are not safe slugs', () => {
  const idx = buildIndex(
    [
      { slug: 'empty', files: ['chunk-0-00001.m4s'] },
      { slug: 'Bad_Name', files: ['master.m3u8'] },
      { slug: '../x', files: ['master.m3u8'] },
    ],
    { now: NOW },
  )
  assert.deepEqual(idx.titles, [])
})

test('live is only flagged for HLS titles, and only when the origin can simulate it', () => {
  const listing = [
    { slug: 'a', files: ['master.m3u8'] },
    { slug: 'b', files: ['manifest.mpd'] },
  ]
  assert.deepEqual(buildIndex(listing, { live: true, now: NOW }).titles, [
    { id: 'a', protocols: ['hls'], live: true },
    { id: 'b', protocols: ['dash'] },
  ])
  assert.deepEqual(buildIndex(listing, { now: NOW }).titles[0], { id: 'a', protocols: ['hls'] })
})
