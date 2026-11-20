import type { Delivery } from './catalog'

export const SLOT_COUNT = 4

export interface PlayerState {
  slots: (string | null)[]
  /** How each quadrant gets its bytes, chosen per quadrant so one title can be compared across sources. */
  deliveries: Delivery[]
  /** Index of the quadrant that owns audio. */
  focused: number
  /** Ad currently playing over a quadrant, if any. */
  ad: { slot: number; clipUrl: string; label?: string; attribution?: string } | null
}

export type Action =
  | { type: 'setStream'; slot: number; streamId: string | null }
  | { type: 'setDelivery'; slot: number; delivery: Delivery }
  | { type: 'focus'; slot: number }
  | { type: 'startAd'; slot: number; clipUrl: string; label?: string; attribution?: string }
  | { type: 'endAd' }

export const initialState: PlayerState = {
  slots: Array(SLOT_COUNT).fill(null),
  deliveries: Array(SLOT_COUNT).fill('direct'),
  focused: 0,
  ad: null,
}

export function reducer(state: PlayerState, action: Action): PlayerState {
  switch (action.type) {
    case 'setStream': {
      const slots = state.slots.slice()
      slots[action.slot] = action.streamId
      // A stream change under a running ad would orphan the overlay.
      return { ...state, slots, ad: state.ad?.slot === action.slot ? null : state.ad }
    }
    case 'setDelivery': {
      if (action.slot < 0 || action.slot >= SLOT_COUNT || state.deliveries[action.slot] === action.delivery) return state
      const deliveries = state.deliveries.slice()
      deliveries[action.slot] = action.delivery
      // The stream underneath is about to reload from another source, so an ad over it would be orphaned.
      return { ...state, deliveries, ad: state.ad?.slot === action.slot ? null : state.ad }
    }
    case 'focus':
      return action.slot >= 0 && action.slot < SLOT_COUNT ? { ...state, focused: action.slot } : state
    case 'startAd':
      // Re-validate here: state may have changed while the ad was being fetched.
      return state.ad || !canHostAd(state, action.slot)
        ? state
        : { ...state, ad: { slot: action.slot, clipUrl: action.clipUrl, label: action.label, attribution: action.attribution } }
    case 'endAd':
      return state.ad ? { ...state, ad: null } : state
  }
}

/** Only the focused quadrant is audible. */
export function isMuted(state: PlayerState, slot: number): boolean {
  return state.focused !== slot
}

/** Ads go in a quadrant that has a stream and is not the focused one. */
function canHostAd(state: PlayerState, slot: number): boolean {
  return slot !== state.focused && state.slots[slot] != null
}

export function pickAdSlot(state: PlayerState, rand: () => number = Math.random): number | null {
  const eligible = state.slots.map((_, i) => i).filter((i) => canHostAd(state, i))
  return eligible.length ? eligible[Math.floor(rand() * eligible.length)] : null
}

/** The ad owns the audio of its quadrant; the stream underneath stays muted while it plays. */
export function isStreamMuted(state: PlayerState, slot: number): boolean {
  return isMuted(state, slot) || state.ad?.slot === slot
}
