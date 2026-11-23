import { describe, expect, it } from 'vitest'
import { formatAge, mergeUploads, playerHref } from './format'
import type { UploadRow } from './types'

const row = (id: string, over: Partial<UploadRow> = {}): UploadRow => ({
  id, name: `${id}.mov`, status: 'success', bytes: 1, sha256: null, outputId: `ugc-${id}`, createdAt: 0, endedAt: 1, durationMs: 1, errorCode: null, owner: 'pat', ...over,
})

describe('playerHref', () => {
  it('links a finished upload to the HLS copy on the local origin', () => {
    expect(playerHref(row('a'))).toBe('/?delivery=local&stream=ugc-a-hls')
  })
  it('has no link for a failed, running or unpublished upload', () => {
    expect(playerHref(row('a', { status: 'failed' }))).toBeNull()
    expect(playerHref(row('a', { status: 'running' }))).toBeNull()
    expect(playerHref(row('a', { outputId: null }))).toBeNull()
  })
})

describe('mergeUploads', () => {
  it('appends a page and keeps order', () => {
    expect(mergeUploads([row('a'), row('b')], [row('c')]).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
  it('drops rows that are already shown', () => {
    expect(mergeUploads([row('a'), row('b')], [row('b'), row('c')]).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('formatAge', () => {
  const now = Date.UTC(2026, 10, 23, 12)
  it('counts up in sensible units', () => {
    expect(formatAge(now - 5_000, now)).toBe('just now')
    expect(formatAge(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2 d ago')
  })
  it('falls back to a date after two weeks', () => {
    expect(formatAge(Date.UTC(2026, 9, 1), now)).toBe('2026-10-01')
  })
})
