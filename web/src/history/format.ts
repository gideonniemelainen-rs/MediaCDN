// Display and list helpers for the history tables. Pure.
import type { UploadRow } from './types'

/** Where to watch a finished upload: the main player, on the local origin. */
export const playerHref = (row: Pick<UploadRow, 'status' | 'outputId'>): string | null =>
  row.status === 'success' && row.outputId ? `/?delivery=local&stream=${encodeURIComponent(`${row.outputId}-hls`)}` : null

/** Appends a page to what is already shown, dropping rows that are already there (a refresh can overlap). */
export function mergeUploads(shown: readonly UploadRow[], page: readonly UploadRow[]): UploadRow[] {
  const ids = new Set(shown.map((r) => r.id))
  return [...shown, ...page.filter((r) => !ids.has(r.id))]
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a date. */
export function formatAge(at: number, now: number): string {
  const d = now - at
  if (d < MINUTE) return 'just now'
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`
  if (d < 14 * DAY) return `${Math.floor(d / DAY)} d ago`
  return new Date(at).toISOString().slice(0, 10)
}
