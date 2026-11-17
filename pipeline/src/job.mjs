// Job identity. The key is derived from the source bytes, the pipeline version and the profile,
// so re-ingesting the same file with the same settings is a no-op.
import { createHash } from 'node:crypto'

export const PIPELINE_VERSION = '0.1.0'

export const sha256 = (s) => createHash('sha256').update(s).digest('hex')

export function jobKey(sourceSha256, profile) {
  return sha256(`${sourceSha256}:${PIPELINE_VERSION}:${JSON.stringify(profile)}`).slice(0, 16)
}

/** Lowercase kebab-case slug, matching the asset ids used in media/sources.json. */
export function slugify(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'asset'
}
