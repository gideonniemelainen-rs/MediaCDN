import type { EventType, TelemetryEvent } from './types'

const MAX_EVENTS = 5000
const NOTIFY_MS = 250

/** Bounded in-memory event log; subscribers are notified at most every NOTIFY_MS. */
export class Telemetry {
  private events: TelemetryEvent[] = []
  private listeners = new Set<() => void>()
  private version = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  record(e: Omit<TelemetryEvent, 't'> & { t?: number }): void {
    this.events.push({ ...e, t: e.t ?? performance.now() })
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    this.scheduleNotify()
  }

  clear(): void {
    this.events = []
    this.scheduleNotify()
  }

  getEvents(): readonly TelemetryEvent[] {
    return this.events
  }

  /** Changes on every notification; use as the useSyncExternalStore snapshot. */
  getVersion = (): number => this.version

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private scheduleNotify(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.version++
      this.listeners.forEach((fn) => fn())
    }, NOTIFY_MS)
  }
}

export const telemetry = new Telemetry()

export type { EventType, TelemetryEvent }
