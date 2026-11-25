// The Title layout: the file names inside a packaged title (origin/<id>/) and the URLs the app builds from them.
// Two packagers write these names and the origin, the index builders, the verify stage and the web catalog read
// them, so they are defined here once. Pure and free of Node imports, so the web app can use it too.
//
//   master.m3u8  manifest.mpd  media_<rep>.m3u8  init-<rep>.m4s  chunk-<rep>-<NNNNN>.m4s
//   live<rep>-<seq>.m4s (the origin's simulated live segments, never written by a packager)
//
// `rep` is the representation number: video rungs 0..n-1, audio n.

export type Protocol = 'hls' | 'dash'

export const HLS_MASTER = 'master.m3u8'
export const DASH_MANIFEST = 'manifest.mpd'
export const INDEX_FILE = 'index.json'

/** The manifest a title offers for each protocol. */
export const MANIFEST: Record<Protocol, string> = { hls: HLS_MASTER, dash: DASH_MANIFEST }

// --- file names ----------------------------------------------------------------------------------

export const mediaPlaylist = (rep: number): string => `media_${rep}.m3u8`
export const initSegment = (rep: number): string => `init-${rep}.m4s`
export const chunk = (rep: number, number: number): string => `chunk-${rep}-${String(number).padStart(5, '0')}.m4s`
export const liveSegment = (rep: number, seq: number): string => `live${rep}-${seq}.m4s`

const MEDIA_PLAYLIST = /^media_(\d+)\.m3u8$/
const LIVE_SEGMENT = /^live(\d+)-(\d+)\.m4s$/

/** The representation number of a media playlist name, or null if `name` is not one. */
export function mediaPlaylistRep(name: string): number | null {
  const m = MEDIA_PLAYLIST.exec(name)
  return m ? Number(m[1]) : null
}

/** The representation and sequence number of a simulated-live segment name, or null if `name` is not one. */
export function parseLiveSegment(name: string): { rep: number; seq: number } | null {
  const m = LIVE_SEGMENT.exec(name)
  return m ? { rep: Number(m[1]), seq: Number(m[2]) } : null
}

/** True for every name a packager may write into a title. */
export function isTitleFile(name: string): boolean {
  return (
    name === HLS_MASTER ||
    name === DASH_MANIFEST ||
    MEDIA_PLAYLIST.test(name) ||
    /^init-\d+\.m4s$/.test(name) ||
    /^chunk-\d+-\d{5,}\.m4s$/.test(name)
  )
}

/**
 * The name patterns handed to the packaging scripts. `$Rep$` stands for the representation number: each script
 * substitutes what its tool uses (`$RepresentationID$` for ffmpeg, the loop index for Shaka Packager).
 * `$Number%05d$` is DASH template syntax that both tools understand.
 */
export const TEMPLATES = {
  init: 'init-$Rep$.m4s',
  chunk: 'chunk-$Rep$-$Number%05d$.m4s',
  playlist: 'media_$Rep$.m3u8',
}

/** The names the packaging scripts need, as the environment variables they read, so no script types a layout name. */
export const packagerEnv = (): Record<string, string> => ({
  INIT_TEMPLATE: TEMPLATES.init,
  CHUNK_TEMPLATE: TEMPLATES.chunk,
  PLAYLIST_TEMPLATE: TEMPLATES.playlist,
  HLS_MASTER,
  DASH_MANIFEST,
})

/** What a template names for one representation, as the packagers expand it. Used to check the two agree. */
export function expandTemplate(template: string, rep: number, number?: number): string {
  const out = template.replaceAll('$Rep$', String(rep))
  return number === undefined ? out : out.replace('$Number%05d$', String(number).padStart(5, '0'))
}

// --- ids and URLs --------------------------------------------------------------------------------

/** A title id: lower case letters, digits and hyphens, not starting with a hyphen. Safe in a path and a URL. */
export const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/
export const isSafeId = (id: string): boolean => SAFE_ID.test(id)

/** Where a title's manifest is, under a delivery's path prefix (`''` for the origin's own root). */
export const titleLocation = (prefix: string, id: string, protocol: Protocol): string => `${prefix}/${id}/${MANIFEST[protocol]}`

/** Where the origin serves a title as simulated live (HLS only). */
export const liveLocation = (id: string): string => `/live/${id}/${HLS_MASTER}`

/** Where a delivery publishes its title index. */
export const indexLocation = (base: string, prefix: string): string => `${base}${prefix}/${INDEX_FILE}`

/** `live/<slug>/<file>` (the origin's simulated-live route, relative path, no leading slash), or null. */
export function parseLivePath(rel: string): { slug: string; file: string } | null {
  const m = /^live\/([\w-]+)\/([\w.-]+)$/.exec(rel)
  return m ? { slug: m[1], file: m[2] } : null
}

// --- the title index -----------------------------------------------------------------------------
// index.json: the small file every origin publishes so the app can list its titles without listing a bucket.

export interface IndexTitle {
  id: string
  protocols: Protocol[]
  /** The origin can also serve this title as simulated live (local only). */
  live?: boolean
}
export interface TitleIndex {
  version: 1
  generatedAt?: string
  titles: IndexTitle[]
}

/**
 * Builds the index from a listing of `{ slug, files }`, where `files` are the names found directly under that title.
 * A title is listed when it has an HLS master or a DASH manifest. `live` marks titles the origin can also serve as
 * simulated live (local only, HLS only).
 */
export function buildIndex(
  listing: { slug: string; files: string[] }[],
  { live = false, now = new Date() }: { live?: boolean; now?: Date } = {},
): TitleIndex {
  const titles: IndexTitle[] = []
  for (const { slug, files } of listing) {
    if (!isSafeId(slug)) continue
    const names = new Set(files)
    const protocols = (Object.keys(MANIFEST) as Protocol[]).filter((p) => names.has(MANIFEST[p]))
    if (!protocols.length) continue
    titles.push({ id: slug, protocols, ...(live && protocols.includes('hls') ? { live: true } : {}) })
  }
  titles.sort((a, b) => a.id.localeCompare(b.id))
  return { version: 1, generatedAt: now.toISOString(), titles }
}

/** Validates an index document; unknown protocols and unsafe ids are dropped, a bad shape throws. */
export function parseIndex(json: unknown): TitleIndex {
  const j = json as { version?: unknown; generatedAt?: unknown; titles?: unknown } | null
  if (!j || j.version !== 1 || !Array.isArray(j.titles)) throw new Error('not a title index (expected version 1 and titles[])')
  const titles: IndexTitle[] = []
  for (const t of j.titles as Partial<IndexTitle>[]) {
    if (typeof t?.id !== 'string' || !isSafeId(t.id) || !Array.isArray(t.protocols)) continue
    const protocols = t.protocols.filter((p): p is Protocol => p === 'hls' || p === 'dash')
    if (protocols.length) titles.push({ id: t.id, protocols, ...(t.live ? { live: true } : {}) })
  }
  return { version: 1, ...(typeof j.generatedAt === 'string' ? { generatedAt: j.generatedAt } : {}), titles }
}

// --- media playlists -----------------------------------------------------------------------------

export interface MediaPlaylist {
  /** The `#EXT-X-MAP` init segment, if the playlist has one. */
  init: string | null
  segments: { uri: string; duration: number }[]
}

/** Parses an HLS media playlist as the packagers write it (fMP4, one file per segment). */
export function parseMediaPlaylist(text: string): MediaPlaylist {
  const lines = text.split(/\r?\n/)
  const init = lines.find((l) => l.startsWith('#EXT-X-MAP:'))?.match(/URI="([^"]+)"/)?.[1] ?? null
  const segments: MediaPlaylist['segments'] = []
  let dur: number | null = null
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8))
    else if (line && !line.startsWith('#') && dur !== null) {
      segments.push({ uri: line.trim(), duration: dur })
      dur = null
    }
  }
  if (!segments.length) throw new Error('playlist has no segments')
  return { init, segments }
}
