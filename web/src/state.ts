export const SLOT_COUNT = 4

export interface PlayerState {
  slots: (string | null)[]
  /** Index of the quadrant that owns audio. */
  focused: number
}

export type Action =
  | { type: 'setStream'; slot: number; streamId: string | null }
  | { type: 'focus'; slot: number }

export const initialState: PlayerState = {
  slots: Array(SLOT_COUNT).fill(null),
  focused: 0,
}

export function reducer(state: PlayerState, action: Action): PlayerState {
  switch (action.type) {
    case 'setStream': {
      const slots = state.slots.slice()
      slots[action.slot] = action.streamId
      return { ...state, slots }
    }
    case 'focus':
      return action.slot >= 0 && action.slot < SLOT_COUNT ? { ...state, focused: action.slot } : state
  }
}

/** Only the focused quadrant is audible. */
export function isMuted(state: PlayerState, slot: number): boolean {
  return state.focused !== slot
}
