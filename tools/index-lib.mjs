// Title index: the small JSON file (index.json) every packaged origin publishes so the app can
// discover what is available without listing a bucket. Pure; used by the local origin server and
// by tools/s3-index.mjs.

const SLUG = /^[a-z0-9][a-z0-9-]*$/

/**
 * Builds the index from a listing of `{ slug, files }`, where `files` are the names found directly
 * under that title. A title is listed when it has an HLS master (`master.m3u8`) or a DASH manifest
 * (`manifest.mpd`). `live` marks titles the origin can also serve as simulated live (local only).
 */
export function buildIndex(listing, { live = false, now = new Date() } = {}) {
  const titles = []
  for (const { slug, files } of listing) {
    if (!SLUG.test(slug)) continue
    const names = new Set(files)
    const protocols = []
    if (names.has('master.m3u8')) protocols.push('hls')
    if (names.has('manifest.mpd')) protocols.push('dash')
    if (!protocols.length) continue
    titles.push({ id: slug, protocols, ...(live && protocols.includes('hls') ? { live: true } : {}) })
  }
  titles.sort((a, b) => a.id.localeCompare(b.id))
  return { version: 1, generatedAt: now.toISOString(), titles }
}
