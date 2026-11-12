import shaka from 'shaka-player'
import type { Delivery } from '../catalog'
import { telemetry } from './store'

interface Ctx {
  slot: number
  streamId: string
  delivery: Delivery
}

const REQUEST_KINDS: Record<number, string> = { 0: 'manifest', 1: 'segment', 2: 'license', 3: 'app', 4: 'timing' }
const SAMPLE_MS = 1000

/** Headers worth keeping: cache/CDN diagnostics, not the whole set. */
const KEEP_HEADER = /^(x-cache|x-served-by|via|age|cache-control|server|cf-cache-status|x-goog-.*)$/i

/** Feeds one quadrant's Shaka player and video element into the telemetry store. Returns a detach function. */
export function attachTelemetry(player: shaka.Player, video: HTMLVideoElement, ctx: Ctx): () => void {
  const rec = (type: Parameters<typeof telemetry.record>[0]['type'], data: Record<string, unknown> = {}) =>
    telemetry.record({ ...ctx, type, data })

  let firstFrame = false
  const onPlaying = () => {
    if (firstFrame) return
    firstFrame = true
    rec('first-frame')
  }
  video.addEventListener('playing', onPlaying)

  const onBuffering = (e: Event) => rec((e as unknown as { buffering: boolean }).buffering ? 'buffering-start' : 'buffering-end')
  const onVariant = () => {
    const t = player.getVariantTracks().find((v) => v.active)
    if (t) rec('variant-change', { bandwidth: t.bandwidth, width: t.width, height: t.height, codecs: t.codecs })
  }
  const onError = (e: Event) => {
    const d = (e as unknown as { detail: shaka.util.Error }).detail
    rec('error', { code: d.code, category: d.category, severity: d.severity, data: d.data?.map(String) })
  }
  player.addEventListener('buffering', onBuffering)
  player.addEventListener('variantchanged', onVariant)
  player.addEventListener('adaptation', onVariant)
  player.addEventListener('error', onError)

  const engine = player.getNetworkingEngine()
  const filter: shaka.extern.ResponseFilter = (type, response) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(response.headers)) if (KEEP_HEADER.test(k)) headers[k] = v
    rec('request', {
      kind: REQUEST_KINDS[type] ?? String(type),
      url: response.uri,
      status: response.status,
      bytes: response.data.byteLength,
      latencyMs: response.timeMs,
      fromCache: response.fromCache,
      headers,
    })
  }
  engine?.registerResponseFilter(filter)

  const timer = setInterval(() => {
    const s = player.getStats()
    const buf = video.buffered
    const ahead = buf.length ? Math.max(0, buf.end(buf.length - 1) - video.currentTime) : 0
    const live = player.isLive()
    rec('sample', {
      estimatedBandwidth: s.estimatedBandwidth,
      streamBandwidth: s.streamBandwidth,
      width: s.width,
      height: s.height,
      bufferedAhead: ahead,
      decodedFrames: s.decodedFrames,
      droppedFrames: s.droppedFrames,
      liveLatencyS: live ? player.seekRange().end - video.currentTime : null,
    })
  }, SAMPLE_MS)

  return () => {
    clearInterval(timer)
    video.removeEventListener('playing', onPlaying)
    player.removeEventListener('buffering', onBuffering)
    player.removeEventListener('variantchanged', onVariant)
    player.removeEventListener('adaptation', onVariant)
    player.removeEventListener('error', onError)
    engine?.unregisterResponseFilter(filter)
  }
}

export function recordLoadStart(ctx: Ctx, url: string): void {
  telemetry.record({ ...ctx, type: 'load-start', data: { url } })
}

export function recordAbrCap(ctx: Ctx, maxHeight: number): void {
  telemetry.record({ ...ctx, type: 'abr-cap', data: { maxHeight } })
}
