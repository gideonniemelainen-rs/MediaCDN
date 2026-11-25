import { useEffect, useSyncExternalStore } from 'react'
import { type Delivery, deliveriesVersion, isEnabled, isIndexed, subscribeDeliveries } from './deliveries'
import { catalogVersion, indexStatus, loadIndex, subscribeCatalog } from './indexStore'

/**
 * Loads the title index of every delivery in use (each quadrant has its own) and re-renders when
 * any of them changes. A disabled delivery is not loaded. `reload` refetches them all.
 */
export function useCatalogs(deliveries: readonly Delivery[]) {
  useSyncExternalStore(subscribeCatalog, catalogVersion)
  // A settings change (a new base URL, a delivery switched on) is the reason to look again, not a catalog change:
  // a failed load changes the catalog too, and reloading on that would retry forever.
  const settingsChange = useSyncExternalStore(subscribeDeliveries, deliveriesVersion)
  const indexed = [...new Set(deliveries)].filter((d) => isIndexed(d) && isEnabled(d)).sort()
  const key = indexed.join()
  useEffect(() => {
    for (const d of key ? (key.split(',') as Delivery[]) : []) void loadIndex(d)
  }, [key, settingsChange])
  return {
    indexed,
    statusOf: indexStatus,
    reload: () => indexed.forEach((d) => void loadIndex(d, true)),
  }
}
