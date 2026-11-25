import shaka from 'shaka-player'
import type { Delivery } from '../deliveries'
import { telemetry } from './store'
import { pickTiming, type TimingEntry } from './transport'

interface Ctx {
  slot: number
  streamId: string
  delivery: Delivery
}

const REQUEST_KINDS: Record<number, string> = { 0: 'manifest', 1: 'segment', 2: 'license', 3: 'app', 4: 'timing' }
const SAMPLE_MS = 1000

/** Headers worth keeping: cache/CDN diagnostics, not the whole set. */
const KEEP_HEADER = /^(x-cache|x-served-by|via|age|alt-svc|cache-control|server|cf-cache-status|x-goog-.*)$/i

const TIMING_KEEP = 1000
/** Resource-timing entries can land after Shaka's response filter runs, so retry the lookup a few times. */
const TIMING_RETRY_MS = [0, 50, 150, 400]
const timings: TimingEntry[] = []
const claimed = new Set<TimingEntry>()
let observing = false

/** Collects resource-timing entries for every request, for all quadrants, from the first call on. */
function observeTimings(): void {
  if (observing || typeof PerformanceObserver === 'undefined') return
  observing = true
  performance.setResourceTimingBufferSize?.(2000)
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) timings.push(e as PerformanceResourceTiming)
    for (const e of timings.splice(0, Math.max(0, timings.length - TIMING_KEEP))) claimed.delete(e)
  }).observe({ type: 'resource', buffered: true })
}

/** Fills `transport`, `connectMs` and `ttfbMs` into a recorded request once its timing entry is there. */
function resolveTransport(data: Record<string, unknown>, uri: string, at: number, attempt = 0): void {
  const t = pickTiming(timings, uri, at, claimed)
  if (t) return void Object.assign(data, t)
  if (attempt + 1 < TIMING_RETRY_MS.length) setTimeout(() => resolveTransport(data, uri, at, attempt + 1), TIMING_RETRY_MS[attempt + 1])
}

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

  observeTimings()
  const engine = player.getNetworkingEngine()
  const filter: shaka.extern.ResponseFilter = (type, response) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(response.headers)) if (KEEP_HEADER.test(k)) headers[k] = v
    const data: Record<string, unknown> = {
      kind: REQUEST_KINDS[type] ?? String(type),
      url: response.uri,
      status: response.status,
      bytes: response.data.byteLength,
      latencyMs: response.timeMs,
      fromCache: response.fromCache,
      headers,
      transport: 'unknown',
      connectMs: null,
      ttfbMs: null,
      httpCache: false,
    }
    rec('request', data)
    resolveTransport(data, response.uri, performance.now())
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
