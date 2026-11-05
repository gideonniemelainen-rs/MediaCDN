import { describe, expect, it } from 'vitest'
import { initialState, isMuted, isStreamMuted, pickAdSlot, reducer } from './state'

describe('player state', () => {
  it('sets and clears a stream in one slot only', () => {
    const a = reducer(initialState, { type: 'setStream', slot: 2, streamId: 'bbb-dash' })
    expect(a.slots).toEqual([null, null, 'bbb-dash', null])
    const b = reducer(a, { type: 'setStream', slot: 2, streamId: null })
    expect(b.slots).toEqual([null, null, null, null])
  })

  it('leaves exactly one slot unmuted', () => {
    const s = reducer(initialState, { type: 'focus', slot: 3 })
    expect([0, 1, 2, 3].filter((i) => !isMuted(s, i))).toEqual([3])
  })

  it('ignores out-of-range focus', () => {
    expect(reducer(initialState, { type: 'focus', slot: 9 })).toBe(initialState)
  })
})

describe('ads', () => {
  const filled = [0, 1, 2].reduce(
    (s, slot) => reducer(s, { type: 'setStream', slot, streamId: 'bbb-dash' }),
    initialState, // slot 0 focused, slot 3 empty
  )

  it('never picks the focused or an empty slot', () => {
    for (const r of [0, 0.5, 0.99]) {
      expect([1, 2]).toContain(pickAdSlot(filled, () => r))
    }
  })

  it('picks nothing when no quadrant is eligible', () => {
    expect(pickAdSlot(initialState)).toBeNull()
  })

  it('rejects an ad on the focused or empty slot, even if state changed after the pick', () => {
    expect(reducer(filled, { type: 'startAd', slot: 0, clipUrl: 'x' }).ad).toBeNull()
    expect(reducer(filled, { type: 'startAd', slot: 3, clipUrl: 'x' }).ad).toBeNull()
  })

  it('moves audio to the ad when its quadrant is focused', () => {
    const playing = reducer(filled, { type: 'startAd', slot: 1, clipUrl: 'x' })
    expect(isStreamMuted(playing, 1)).toBe(true)
    expect(isMuted(playing, 1)).toBe(true)
    const focused = reducer(playing, { type: 'focus', slot: 1 })
    expect(isMuted(focused, 1)).toBe(false) // ad audible
    expect(isStreamMuted(focused, 1)).toBe(true) // stream under it still muted
  })

  it('clears the ad when its stream changes or it ends', () => {
    const playing = reducer(filled, { type: 'startAd', slot: 1, clipUrl: 'x' })
    expect(reducer(playing, { type: 'setStream', slot: 1, streamId: null }).ad).toBeNull()
    expect(reducer(playing, { type: 'endAd' }).ad).toBeNull()
  })
})
