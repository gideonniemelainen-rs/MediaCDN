import { useEffect, useSyncExternalStore } from 'react'
import { getAuth, refreshAuth, subscribeAuth } from './store'

let asked = false

export function useAuth() {
  const state = useSyncExternalStore(subscribeAuth, getAuth)
  useEffect(() => {
    if (asked) return
    asked = true
    void refreshAuth()
  }, [])
  return state
}
