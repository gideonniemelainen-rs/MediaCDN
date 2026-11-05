import { describe, expect, it } from 'vitest'
import { initialState, isMuted, reducer } from './state'

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
