import { useSyncExternalStore } from 'react'
import { telemetry } from './store'

/** Re-renders the caller whenever the telemetry store notifies. */
export function useTelemetryVersion(): number {
  return useSyncExternalStore(telemetry.subscribe, telemetry.getVersion)
}
