import { useEffect, useSyncExternalStore } from 'react'
import { type Delivery, catalogVersion, indexStatus, loadIndex, subscribeCatalog } from './catalog'

/** Loads the selected delivery's title index (if it has one) and re-renders when it changes. */
export function useCatalog(delivery: Delivery) {
  useSyncExternalStore(subscribeCatalog, catalogVersion)
  useEffect(() => {
    void loadIndex(delivery)
  }, [delivery])
  return { status: indexStatus(delivery), reload: () => void loadIndex(delivery, true) }
}
