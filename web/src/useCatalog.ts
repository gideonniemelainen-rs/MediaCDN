import { useEffect, useSyncExternalStore } from 'react'
import { type Delivery, isIndexed } from './deliveries'
import { catalogVersion, indexStatus, loadIndex, subscribeCatalog } from './indexStore'

/**
 * Loads the title index of every delivery in use (each quadrant has its own) and re-renders when
 * any of them changes. `reload` refetches them all.
 */
export function useCatalogs(deliveries: readonly Delivery[]) {
  useSyncExternalStore(subscribeCatalog, catalogVersion)
  const indexed = [...new Set(deliveries)].filter(isIndexed).sort()
  const key = indexed.join()
  useEffect(() => {
    for (const d of key ? (key.split(',') as Delivery[]) : []) void loadIndex(d)
  }, [key])
  return {
    indexed,
    statusOf: indexStatus,
    reload: () => indexed.forEach((d) => void loadIndex(d, true)),
  }
}
