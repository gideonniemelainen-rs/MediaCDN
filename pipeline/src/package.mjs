// Pure helpers for the package, verify and publish stages. These reuse the origin's own parsing
// (tools/live.mjs, tools/index-lib.mjs), so "verified" means "the origin and player can use it".
import { buildIndex } from '../../tools/index-lib.mjs'
import { parseMediaPlaylist } from '../../tools/live.mjs'

const MAX_SEGMENT_SECONDS = 6

/**
 * Output id for an upload: `ugc-<slug>` so uploads cannot overwrite sample titles. `existing`
 * maps each directory already in origin/ to the source sha recorded in it (null if none). A
 * clash with someone else's directory gets a suffix from the sha, which is stable per content.
 */
export function chooseOutputId(slug, sha, existing) {
  const base = `ugc-${slug}`.slice(0, 60).replace(/-+$/, '')
  const free = (id) => !existing.has(id) || existing.get(id) === sha
  if (free(base)) return base
  for (let n = 6; n <= sha.length; n += 2) {
    const id = `${base}-${sha.slice(0, n)}`
    if (free(id)) return id
  }
  throw new Error('no free output id')
}

const attr = (line, name) => new RegExp(`${name}=("([^"]*)"|[^,]*)`).exec(line)?.[2] ?? new RegExp(`${name}=([^,]*)`).exec(line)?.[1]

/** Structural checks of a packaged title: `files` are the names in its directory, `playlists` maps name to text. */
export function verifyPackage({ id, files, master, playlists, mpd }) {
  const names = new Set(files)
  const lines = master.split(/\r?\n/)
  const variants = lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF:'))
  const renditions = variants.map((l) => ({ bandwidth: Number(attr(l, 'BANDWIDTH')), resolution: attr(l, 'RESOLUTION') ?? null }))
  const audio = lines.filter((l) => l.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(l))
  const referenced = [
    ...lines.filter((l) => l && !l.startsWith('#')),
    ...lines.map((l) => /^#EXT-X-MEDIA:.*URI="([^"]+)"/.exec(l)?.[1]).filter(Boolean),
  ]

  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok, ...(detail && { detail }) })

  check('HLS master present', names.has('master.m3u8'))
  check('DASH manifest present', names.has('manifest.mpd'))
  check('Video renditions in master', renditions.length > 0, `${renditions.length} renditions`)
  check('Audio rendition in master', audio.length > 0)
  const missing = referenced.filter((u) => !(u in playlists))
  check('Media playlists present', referenced.length > 0 && missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${referenced.length} playlists`)

  let segments = 0
  let longest = 0
  const lost = []
  for (const [name, text] of Object.entries(playlists)) {
    try {
      const parsed = parseMediaPlaylist(text)
      for (const f of [parsed.init, ...parsed.segments.map((s) => s.uri)].filter(Boolean)) if (!names.has(f)) lost.push(f)
      segments += parsed.segments.length
      longest = Math.max(longest, ...parsed.segments.map((s) => s.duration))
    } catch (e) {
      lost.push(`${name} (${e.message})`)
    }
  }
  check('All segments present', Object.keys(playlists).length > 0 && lost.length === 0, lost.length ? `missing ${lost.slice(0, 3).join(', ')}` : `${segments} segments`)
  // Not a live window: a finished upload must be a complete, seekable title in both formats.
  check('HLS playlists are complete (VOD)', Object.keys(playlists).length > 0 && Object.values(playlists).every((t) => t.includes('#EXT-X-ENDLIST')))
  if (mpd !== undefined) check('DASH manifest is static', /\btype="static"/.test(mpd))
  check('Segment length', longest > 0 && longest <= MAX_SEGMENT_SECONDS, `longest ${longest.toFixed(1)} s`)

  const listed = buildIndex([{ slug: id, files }]).titles[0]
  check('Listed by the origin index', !!listed && listed.protocols.includes('hls') && listed.protocols.includes('dash'), listed ? listed.protocols.join(' + ') : 'not listed')

  return { ok: checks.every((c) => c.ok), checks, renditions }
}
