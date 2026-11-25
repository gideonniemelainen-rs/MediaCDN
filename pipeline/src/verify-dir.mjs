// Reads a packaged Title directory and checks it with verifyPackage (package.mjs): what the upload pipeline's verify
// stage and the "package a title" workflow both do, so "verified" means the same in both.
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DASH_MANIFEST, HLS_MASTER, mediaPlaylistRep } from '../../shared/src/title-layout.ts'
import { verifyPackage } from './package.mjs'

export async function verifyTitleDir(dir, id) {
  const files = await readdir(dir)
  const master = await readFile(join(dir, HLS_MASTER), 'utf8').catch(() => '')
  const playlists = {}
  for (const f of files.filter((n) => mediaPlaylistRep(n) !== null)) playlists[f] = await readFile(join(dir, f), 'utf8')
  const mpd = await readFile(join(dir, DASH_MANIFEST), 'utf8').catch(() => undefined)
  return verifyPackage({ id, files, master, playlists, mpd })
}
