// Validate stage: decides whether an upload is accepted and flags what normalise must fix.
// Pure: SourceInfo + limits in, a verdict with stable codes out.

export const ERRORS = {
  E_UNREADABLE: 'container could not be read (corrupt or truncated)',
  E_NO_VIDEO: 'no video stream',
  E_AUDIO_ONLY: 'audio-only input',
  E_BAD_DURATION: 'missing or non-positive duration',
  E_TOO_LONG: 'duration over the limit',
  E_FILE_TOO_LARGE: 'file size over the limit',
  E_RESOLUTION: 'resolution over the limit',
  E_BAD_DIMENSIONS: 'frame size too small or undefined',
  E_CODEC: 'video codec not supported',
  E_DECODE_FAILED: 'decode failed during normalise',
}

export function validate(info, limits) {
  const errors = []
  const warnings = []
  const err = (code, detail) => errors.push({ code, message: ERRORS[code], ...(detail && { detail }) })
  const warn = (code, detail) => warnings.push({ code, detail })

  const v = info.video
  if (!v) {
    err(info.audio.length ? 'E_AUDIO_ONLY' : 'E_NO_VIDEO')
    return { ok: false, errors, warnings, facts: {} }
  }

  if (!(info.duration > 0)) err('E_BAD_DURATION')
  else if (info.duration > limits.maxDurationSec) err('E_TOO_LONG', `${Math.round(info.duration)}s > ${limits.maxDurationSec}s`)
  if (info.bytes > limits.maxFileBytes) err('E_FILE_TOO_LARGE', `${info.bytes} bytes`)
  if (!limits.videoCodecs.includes(v.codec)) err('E_CODEC', v.codec)

  const { displayWidth: w, displayHeight: h } = v
  if (!(w >= limits.minDimension && h >= limits.minDimension)) err('E_BAD_DIMENSIONS', `${w}x${h}`)
  else if (Math.max(w, h) > limits.maxLongSide || Math.min(w, h) > limits.maxShortSide) err('E_RESOLUTION', `${w}x${h}`)

  if (v.vfr) warn('W_VFR', `avg ${v.avgFps.toFixed(2)} vs ${v.rFps.toFixed(2)} fps`)
  if (v.rotation) warn('W_ROTATED', `${v.rotation} deg`)
  if (v.hdr) warn('W_HDR', v.transfer)
  else if (v.bitDepth > 8) warn('W_HIGH_BIT_DEPTH', `${v.bitDepth}-bit`)
  if (Math.abs(v.sar - 1) > 0.01) warn('W_NON_SQUARE_SAR', v.sar.toFixed(3))
  if (v.interlaced) warn('W_INTERLACED')
  if (v.width % 2 || v.height % 2) warn('W_ODD_DIMENSIONS', `${v.width}x${v.height}`)
  if (w > 0 && h > 0 && Math.max(w / h, h / w) > limits.maxAspect) warn('W_EXTREME_ASPECT', `${w}x${h}`)
  const nominal = v.vfr ? v.avgFps : v.rFps
  if (nominal > 0 && nominal < limits.lowFpsWarn) warn('W_LOW_FPS', `${nominal.toFixed(2)} fps`)
  if (!info.audio.length) warn('W_NO_AUDIO')
  else if (info.audio.length > 1) warn('W_MULTI_AUDIO', `${info.audio.length} tracks`)

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    facts: { width: w, height: h, fps: nominal, duration: info.duration, hasAudio: info.audio.length > 0 },
  }
}
