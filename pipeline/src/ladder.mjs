// The ABR ladder. Heights and video bitrates match scripts/package.sh so both packagers offer the
// same renditions; a content-aware ladder (milestone 2) will replace the table, not the callers.

/** `{ height, kbps }`, lowest first. */
export const RUNGS = [
  { height: 240, kbps: 400 },
  { height: 360, kbps: 800 },
  { height: 480, kbps: 1400 },
  { height: 720, kbps: 2800 },
  { height: 1080, kbps: 5000 },
]

// Unfocused quadrants in the web app cap at 360p, so a rung at or below it must always exist.
export const LOW_RUNG_HEIGHT = 360

/**
 * Rungs for a source of `sourceHeight` (never upscaling). `quick` keeps only 360p and 720p.
 * A source shorter than the smallest rung gets one rung at its own height.
 */
export function selectRungs(sourceHeight, { quick = false } = {}) {
  const table = quick ? RUNGS.filter((r) => r.height === 360 || r.height === 720) : RUNGS
  const picked = table.filter((r) => r.height <= sourceHeight)
  return picked.length ? picked : [{ height: sourceHeight, kbps: 800 }]
}

/** `360:800 720:2800`, the form the packaging scripts take. */
export const formatRungs = (rungs) => rungs.map((r) => `${r.height}:${r.kbps}`).join(' ')
