import { useSyncExternalStore } from 'react'
import { getSettingsState, settingsVersion, subscribeSettings } from './store'

/**
 * Re-renders when the settings change, and gives their status. Read the values themselves with `playerSettings()` and
 * the deliveries helpers during render: they are current whenever this hook has just rendered.
 */
export function useSettings() {
  useSyncExternalStore(subscribeSettings, settingsVersion)
  return getSettingsState()
}
