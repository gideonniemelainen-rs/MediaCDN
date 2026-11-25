// Initial state requested through the URL, e.g. /?delivery=local&stream=ugc-demo-hls, which is how
// the upload page opens a freshly published title in the player. Pure.
import { isSafeId } from '@shared/title-layout.ts'
import { DELIVERIES, type Delivery } from './catalog'

export interface Launch {
  delivery?: Delivery
  stream?: string
}

export function readLaunch(search: string): Launch {
  const params = new URLSearchParams(search)
  const delivery = DELIVERIES.find((d) => d === params.get('delivery'))
  const stream = params.get('stream') ?? ''
  return { ...(delivery && { delivery }), ...(isSafeId(stream) && { stream }) }
}
