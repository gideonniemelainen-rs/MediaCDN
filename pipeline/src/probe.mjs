// Probe stage: runs ffprobe and reduces its JSON to the facts validate and normalise need.
// `summarise` is pure so it can be tested against ffprobe-shaped fixtures without ffmpeg.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67'])

/** Parses ffprobe rationals like "30000/1001"; returns 0 for "0/0" or junk. */
export function parseRate(r) {
  if (!r) return 0
  const [n, d = '1'] = String(r).split('/')
  const v = Number(n) / Number(d)
  return Number.isFinite(v) ? v : 0
}

function parseSar(s) {
  if (!s || s === 'N/A') return 1
  const [n, d] = s.split(':').map(Number)
  return n > 0 && d > 0 ? n / d : 1
}

/** Display-matrix or legacy `rotate` tag, normalised to 0/90/180/270. */
function rotationOf(stream) {
  const side = stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation
  const raw = side ?? Number(stream.tags?.rotate ?? 0)
  return ((Math.round(Number(raw)) % 360) + 360) % 360
}

export function summarise(json) {
  const streams = json.streams ?? []
  const format = json.format ?? {}

  const videos = streams.filter((s) => s.codec_type === 'video')
  const attachedPics = videos.filter((s) => s.disposition?.attached_pic === 1)
  const realVideos = videos.filter((s) => s.disposition?.attached_pic !== 1)
  const v = realVideos[0]

  let video = null
  if (v) {
    const rotation = rotationOf(v)
    const rFps = parseRate(v.r_frame_rate)
    const avgFps = parseRate(v.avg_frame_rate)
    const width = Number(v.width)
    const height = Number(v.height)
    const bitDepth = Number(v.bits_per_raw_sample) || (/(10|12)(le|be)?$/.test(v.pix_fmt ?? '') ? Number(/(10|12)/.exec(v.pix_fmt)[1]) : 8)
    video = {
      ordinal: 0,
      codec: v.codec_name,
      width,
      height,
      sar: parseSar(v.sample_aspect_ratio),
      rotation,
      // Dimensions as the viewer sees them after autorotate.
      displayWidth: rotation % 180 === 90 ? height : width,
      displayHeight: rotation % 180 === 90 ? width : height,
      rFps,
      avgFps,
      // Muxers report the lowest common rate as r_frame_rate; a much lower average means gaps.
      vfr: rFps > 0 && avgFps > 0 && Math.abs(rFps - avgFps) / rFps > 0.05,
      pixFmt: v.pix_fmt,
      bitDepth,
      primaries: v.color_primaries,
      transfer: v.color_transfer,
      matrix: v.color_space,
      hdr: HDR_TRANSFERS.has(v.color_transfer),
      interlaced: !!v.field_order && !['progressive', 'unknown'].includes(v.field_order),
    }
  }

  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s, ordinal) => ({
      ordinal,
      codec: s.codec_name,
      channels: Number(s.channels) || 0,
      layout: s.channel_layout,
      sampleRate: Number(s.sample_rate) || 0,
      default: s.disposition?.default === 1,
    }))

  return {
    container: format.format_name,
    duration: Number(format.duration) || Number(v?.duration) || 0,
    bytes: Number(format.size) || 0,
    bitRate: Number(format.bit_rate) || 0,
    video,
    audio,
    subtitles: streams.filter((s) => s.codec_type === 'subtitle').length,
    attachedPics: attachedPics.length,
  }
}

/** Runs ffprobe on a file; rejects if the container cannot be read. */
export async function probe(file) {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { maxBuffer: 32 * 1024 * 1024 },
  )
  return summarise(JSON.parse(stdout))
}
