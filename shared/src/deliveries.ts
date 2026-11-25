// The static facts about each Delivery: its id, label, where its base URL is configured and where its title index
// lives. Which deliveries are enabled and what their base URLs are is configuration (shared/src/settings.ts), not
// listed here. One table, so adding a delivery is one record, not an edit to five parallel tables.

export type Delivery = 'direct' | 'local' | 's3-near' | 's3-far' | 'cdn-public' | 'cdn-s3'

/**
 * The HTTP version asked for, for the local origin only (see infra/local). The other deliveries negotiate
 * whatever their server offers, which the telemetry records as it was observed.
 */
export type Transport = 'h1' | 'h2' | 'h3'

export interface DeliveryInfo {
  id: Delivery
  /** Names for the picker and the on-screen stats. The ids stay as they are in exports. */
  label: string
  /**
   * `VITE_*` variables that give this delivery's base URL by default, first match wins (an older name can follow the
   * current one). Empty for `direct`, which plays public URLs as they are and has no base.
   */
  baseVars: readonly string[]
  /** The base URL when nothing configures one. Only the local origin has one. */
  defaultBase: string | null
  /** Path prefix its index and our own titles live under, or null when titles do not come from an index. */
  indexPrefix: string | null
}

/** In picker order. */
export const DELIVERIES: readonly Delivery[] = ['direct', 'local', 's3-near', 's3-far', 'cdn-public', 'cdn-s3']
export const TRANSPORTS: readonly Transport[] = ['h1', 'h2', 'h3']

export const DELIVERY: Readonly<Record<Delivery, DeliveryInfo>> = {
  direct: { id: 'direct', label: 'Direct (public)', baseVars: [], defaultBase: null, indexPrefix: null },
  local: { id: 'local', label: 'Origin (local)', baseVars: ['VITE_LOCAL_BASE'], defaultBase: 'http://localhost:8788', indexPrefix: '' },
  // VITE_S3_BASE predates the near/far split and still names the near bucket.
  's3-near': { id: 's3-near', label: 'S3 near', baseVars: ['VITE_S3_NEAR_BASE', 'VITE_S3_BASE'], defaultBase: null, indexPrefix: '' },
  's3-far': { id: 's3-far', label: 'S3 far', baseVars: ['VITE_S3_FAR_BASE'], defaultBase: null, indexPrefix: '' },
  'cdn-public': { id: 'cdn-public', label: 'Media CDN → public', baseVars: ['VITE_CDN_BASE'], defaultBase: null, indexPrefix: null },
  'cdn-s3': { id: 'cdn-s3', label: 'Media CDN → S3', baseVars: ['VITE_CDN_BASE'], defaultBase: null, indexPrefix: '/s3' },
}

/** The `VITE_*` variable that gives the local origin's base for each transport lab listener (see infra/local). */
export const TRANSPORT_VAR: Readonly<Record<Transport, string>> = { h1: 'VITE_LOCAL_BASE_H1', h2: 'VITE_LOCAL_BASE_H2', h3: 'VITE_LOCAL_BASE_H3' }

export const isDelivery = (value: unknown): value is Delivery => typeof value === 'string' && Object.hasOwn(DELIVERY, value)
export const isTransport = (value: unknown): value is Transport => typeof value === 'string' && (TRANSPORTS as readonly string[]).includes(value)

/** Deliveries whose titles come from an index, with the path prefix their index and media live under; in picker order. */
export const INDEXED_DELIVERIES: readonly Delivery[] = DELIVERIES.filter((d) => DELIVERY[d].indexPrefix !== null)
export const isIndexed = (delivery: Delivery): boolean => DELIVERY[delivery].indexPrefix !== null

/** Deliveries that have a base URL to configure (all but `direct`). */
export const BASED_DELIVERIES: readonly Delivery[] = DELIVERIES.filter((d) => d !== 'direct')
