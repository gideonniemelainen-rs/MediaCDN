import type { Delivery } from '../catalog'

export type EventType =
  | 'load-start'
  | 'first-frame'
  | 'buffering-start'
  | 'buffering-end'
  | 'variant-change'
  | 'error'
  | 'sample'
  | 'request'
  | 'abr-cap'

export interface TelemetryEvent {
  /** performance.now() timestamp in ms. */
  t: number
  slot: number
  streamId: string
  delivery: Delivery
  type: EventType
  data: Record<string, unknown>
}
