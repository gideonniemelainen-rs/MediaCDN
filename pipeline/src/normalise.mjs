// Normalise stage: plans the ffmpeg run that turns any accepted upload into a uniform mezzanine
// (square pixels, even dimensions, CFR, 8-bit SDR BT.709, stereo audio, no metadata).
// Pure: returns the argument list plus the decisions taken, so both can be tested and recorded.

/** Nearest standard rate (log distance), clamped to the profile's range. */
export function targetFps(nominal, n) {
  const clamped = Math.min(Math.max(nominal || 30, n.minFps), n.maxFps)
  return n.standardFps.reduce((best, f) =>
    Math.abs(Math.log(f / clamped)) < Math.abs(Math.log(best / clamped)) ? f : best,
  )
}

const TONEMAP =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv'

export function planNormalise(info, profile, { input, output }) {
  const n = profile.normalise
  const v = info.video
  const nominal = v.vfr ? v.avgFps : v.rFps
  const fps = targetFps(nominal, n)

  const filters = []
  if (v.interlaced) filters.push('bwdif=mode=send_frame')
  filters.push(`fps=${fps}`)
  // Resample to square pixels and round down to even dimensions in one step. Autorotate has
  // already happened by the time filters run, so iw/ih are display dimensions.
  const sarWidth = v.sar === 1 ? 'iw' : 'iw*sar'
  const matrix = v.matrix && !['bt709', 'bt2020nc', 'bt2020c'].includes(v.matrix) && !v.hdr ? ':out_color_matrix=bt709' : ''
  filters.push(`scale=trunc(${sarWidth}/2)*2:trunc(ih/2)*2${matrix}`, 'setsar=1')
  if (v.hdr) filters.push(TONEMAP)
  filters.push('format=yuv420p')

  const audioTrack = info.audio.find((a) => a.default) ?? info.audio[0] ?? null
  const ln = n.loudnorm
  // Channel layout is fixed before loudnorm (mono sources fail downstream otherwise). loudnorm
  // upsamples to 192 kHz internally, so the resample must follow it, and its oversized first
  // frame is rejected by the FLAC encoder, hence asetnsamples.
  const audioFilters = ['aformat=channel_layouts=stereo']
  if (ln.enabled) audioFilters.push(`loudnorm=I=${ln.i}:TP=${ln.tp}:LRA=${ln.lra}`)
  audioFilters.push(`aresample=${n.audioRate}`, 'aformat=sample_fmts=s16', 'asetnsamples=n=4096:p=0')

  const args = ['-hide_banner', '-loglevel', 'warning', '-y', '-i', input]
  if (!audioTrack) args.push('-f', 'lavfi', '-i', `anullsrc=r=${n.audioRate}:cl=stereo`)
  args.push(
    '-map', `0:v:${v.ordinal}`,
    '-map', audioTrack ? `0:a:${audioTrack.ordinal}` : '1:a:0',
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', filters.join(','),
    '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', n.mezzanine.preset, '-crf', String(n.mezzanine.crf), '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-af', audioFilters.join(','), '-c:a', 'flac',
  )
  // The synthetic silence is endless, so it must not decide the output length.
  if (!audioTrack) args.push('-shortest')
  args.push('-f', 'matroska', output)

  return {
    args,
    decisions: {
      fps,
      sourceFps: nominal,
      rotated: v.rotation,
      deinterlaced: v.interlaced,
      tonemapped: v.hdr,
      squarePixels: Math.abs(v.sar - 1) > 0.01,
      audio: audioTrack ? { track: audioTrack.ordinal, tracks: info.audio.length } : { synthesised: true },
      loudnorm: ln.enabled ? 'single-pass' : 'off',
    },
  }
}
