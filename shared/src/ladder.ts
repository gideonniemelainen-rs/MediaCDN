// The ABR ladder. RUNGS is the fixed table (the same heights and bitrates as scripts/package.sh, so the
// ffmpeg packager and the fallback agree; work item 3 of docs/plans/shared-ladder.md makes this the only copy). planLadder turns a complexity measurement (complexity.mjs)
// into a per-title ladder for the Shaka path: bitrates follow the content, redundant rungs go.

/** One rendition: picture height in pixels and average video bitrate in kbps. */
export type Rung = { height: number; kbps: number }

export type LadderClass = 'screen' | 'film'

export type LadderPlan = {
  rungs: Rung[]
  class: LadderClass
  bpp: number
  dropped: { height: number; reason: string }[]
}

/** Lowest first. */
export const RUNGS: Rung[] = [
  { height: 240, kbps: 400 },
  { height: 360, kbps: 800 },
  { height: 480, kbps: 1400 },
  { height: 720, kbps: 2800 },
  { height: 1080, kbps: 5000 },
]

/** Unfocused quadrants in the web app cap their rendition at this height, so four concurrent decodes stay usable. */
export const UNFOCUSED_MAX_HEIGHT = 360

// A rung at or below the cap must always exist, or an unfocused quadrant would have nothing to play.
export const LOW_RUNG_HEIGHT = UNFOCUSED_MAX_HEIGHT

/**
 * Rungs for a source of `sourceHeight` (never upscaling). `quick` keeps only 360p and 720p.
 * A source shorter than the smallest rung gets one rung at its own height.
 */
export function selectRungs(sourceHeight: number, { quick = false }: { quick?: boolean } = {}): Rung[] {
  const table = quick ? RUNGS.filter((r) => r.height === 360 || r.height === 720) : RUNGS
  const picked = table.filter((r) => r.height <= sourceHeight)
  return picked.length ? picked : [{ height: sourceHeight, kbps: 800 }]
}

/** Heights worth probing for a source of `sourceHeight`: the table rungs it can fill, or its own height if shorter than all. */
export const candidateHeights = (sourceHeight: number): number[] => selectRungs(sourceHeight).map((r) => r.height)

/** `360:800 720:2800`, for logs and the Upload page. The packaging scripts take `encodeSpec` instead. */
export const formatRungs = (rungs: Rung[]): string => rungs.map((r) => `${r.height}:${r.kbps}`).join(' ')

/** Peak and buffer limits (VBV) for a rung, as multiples of its average bitrate: they bound the peaks whatever the rate control. */
export const VBV = { maxrate: 1.5, bufsize: 2 }

/**
 * The ladder in the form both packaging scripts take, one `height:kbps:maxrate:bufsize` token per rung
 * (all kbps, lowest first, space separated), so no script computes a bitrate of its own.
 */
export const encodeSpec = (rungs: Rung[]): string =>
  rungs.map((r) => `${r.height}:${r.kbps}:${Math.floor(r.kbps * VBV.maxrate)}:${Math.floor(r.kbps * VBV.bufsize)}`).join(' ')

// --- content-aware ladder -------------------------------------------------------------------------

/** Constant quality for the probe and for the final encodes, so what the probe measures is what gets made. */
// 21 held VMAF at 94.6 or more on every clip tried (film, two screen recordings, a synthetic stress clip); 23 dropped to 93.0.
export const LADDER_CRF = 21

// Per-height bounds on a rung's average bitrate: the floor keeps a near-static clip from asking for a
// rate no encoder honours, the ceiling (1.5x the fixed table) bounds storage and the VBV cap on noisy content.
const BOUNDS: Record<number, { min: number; max: number }> = {
  240: { min: 80, max: 600 },
  360: { min: 120, max: 1200 },
  480: { min: 180, max: 2100 },
  720: { min: 300, max: 4200 },
  1080: { min: 500, max: 7500 },
}
const bounds = (height: number) => BOUNDS[height] ?? { min: 120, max: 1200 }

/** A rung is dropped when the next one up costs less than this multiple of it: same bitrate, so take the sharper picture. */
export const MIN_STEP = 1.3

/** Below this many bits per pixel per frame (at 720p) the content is screen-like: flat areas, little motion. */
export const SCREEN_BPP = 0.02

/** Bits per pixel per frame for a rung of `height` at `kbps`. */
export const bitsPerPixel = ({ height, kbps, aspect, fps }: Rung & { aspect: number; fps: number }): number => (kbps * 1000) / (height * aspect * height * fps)

const roundTo = (n: number, step: number) => Math.round(n / step) * step

/**
 * @param measured  average kbps of a constant-quality encode at each height (lowest first)
 * @param o         display width / height, and the constant frame rate
 */
export function planLadder(measured: Rung[], { aspect, fps }: { aspect: number; fps: number }): LadderPlan {
  if (!measured.length) throw new Error('planLadder needs at least one measurement')
  const sorted = [...measured].sort((a, b) => a.height - b.height)

  // Complexity is read at the tallest rung up to 720p, where the numbers are comparable across sources.
  const ref = [...sorted].reverse().find((m) => m.height <= 720) ?? sorted[0]
  const bpp = bitsPerPixel({ height: ref.height, kbps: ref.kbps, aspect, fps })
  const contentClass: LadderClass = bpp < SCREEN_BPP ? 'screen' : 'film'

  // Average rate per rung, clamped, and never below the rung under it (a taller picture never costs less).
  let floor = 0
  let rungs = sorted.map((m) => {
    const { min, max } = bounds(m.height)
    const kbps = Math.max(floor, Math.min(max, Math.max(min, roundTo(m.kbps, 10))))
    floor = kbps
    return { height: m.height, kbps }
  })

  const dropped: LadderPlan['dropped'] = []
  // Unfocused quadrants cap at 360p, so the tallest rung at or below it is never removed.
  const lowHeight = Math.max(...rungs.map((r) => r.height).filter((h) => h <= LOW_RUNG_HEIGHT), -1)
  const keep: Rung[] = []
  for (const r of [...rungs].reverse()) {
    const above = keep[0]
    const protectedRung = r.height === lowHeight || r.height === rungs[rungs.length - 1].height
    if (!protectedRung && contentClass === 'screen' && r.height < 360) {
      dropped.push({ height: r.height, reason: 'text is unreadable this small' })
    } else if (!protectedRung && above && above.kbps < r.kbps * MIN_STEP) {
      dropped.push({ height: r.height, reason: `${above.height}p costs about the same (${above.kbps} vs ${r.kbps} kbps)` })
    } else keep.unshift(r)
  }
  rungs = keep
  return { rungs, class: contentClass, bpp, dropped: dropped.reverse() }
}
