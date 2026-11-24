// Measures how expensive a title is to encode, for the content-aware ladder (ladder.mjs).
// A few short windows of the mezzanine are encoded at constant quality (CRF) at every candidate height in
// one ffmpeg pass per window; the size of each output over its duration is the bitrate that quality costs.
// Flat screen recordings come out at a fraction of the bitrate of film at the same height.
import { spawn } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const WINDOW_SEC = 6
export const WINDOWS = 3

/** Where to sample: the whole clip when it is short, otherwise WINDOWS windows centred at 1/6, 1/2 and 5/6 of it. */
export function sampleWindows(duration, { windows = WINDOWS, windowSec = WINDOW_SEC } = {}) {
  if (!(duration > 0)) return []
  if (duration <= windows * windowSec) return [{ start: 0, length: duration }]
  return Array.from({ length: windows }, (_, i) => {
    const centre = duration * ((2 * i + 1) / (2 * windows))
    return { start: Math.max(0, Math.min(duration - windowSec, centre - windowSec / 2)), length: windowSec }
  })
}

/** Keyframe interval in frames for segments of `segmentSec`, as package-shaka.sh derives it (the mezzanine is constant frame rate). */
export const gopFrames = (fps, segmentSec = 4) => Math.max(1, Math.round(fps * segmentSec))

/**
 * ffmpeg arguments for one window: decode once, split to every height, encode each at `crf` into `dir`.
 * `gop` (frames) gives the keyframe spacing of the real encode, which costs bits that ffmpeg's default spacing does not.
 */
export function windowArgs({ input, window, heights, crf, dir, gop, preset = 'veryfast' }) {
  const split = `[0:v]split=${heights.length}${heights.map((_, i) => `[s${i}]`).join('')}`
  const scales = heights.map((h, i) => `[s${i}]scale=-2:${h},setsar=1[v${i}]`)
  const outputs = heights.flatMap((h, i) => ['-map', `[v${i}]`, '-an', '-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-crf', String(crf), '-pix_fmt', 'yuv420p', ...(gop ? ['-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0'] : []), join(dir, `h${h}.mp4`)])
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', window.start.toFixed(3), '-t', window.length.toFixed(3), '-i', input, '-filter_complex', [split, ...scales].join(';'), ...outputs]
}

/** Length-weighted mean of per-window kbps for each height. `perWindow` is [{ length, bytes: {height: n} }]. */
export function averageKbps(perWindow, heights) {
  const seconds = perWindow.reduce((t, w) => t + w.length, 0)
  return heights.map((height) => ({ height, kbps: Math.round((perWindow.reduce((t, w) => t + w.bytes[height], 0) * 8) / seconds / 1000) }))
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-2).join(' | ') || `ffmpeg exited ${code}`))))
  })
}

/**
 * @returns {Promise<{ measured:{height:number,kbps:number}[], windows:{start:number,length:number}[], seconds:number }>}
 * Rejects when ffmpeg fails; the caller falls back to the fixed ladder.
 */
export async function measureComplexity({ mezzanine, duration, heights, crf, gop, tmp, onProgress = () => {}, ffmpeg = 'ffmpeg' }) {
  const windows = sampleWindows(duration)
  if (!windows.length || !heights.length) throw new Error('nothing to measure')
  const perWindow = []
  try {
    for (const [i, window] of windows.entries()) {
      const dir = join(tmp, `w${i}`)
      await mkdir(dir, { recursive: true })
      await run(ffmpeg, windowArgs({ input: mezzanine, window, heights, crf, gop, dir }))
      const bytes = {}
      for (const h of heights) bytes[h] = (await stat(join(dir, `h${h}.mp4`))).size
      perWindow.push({ length: window.length, bytes })
      onProgress((i + 1) / windows.length)
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
  return { measured: averageKbps(perWindow, heights), windows, seconds: windows.reduce((t, w) => t + w.length, 0) }
}
