#!/usr/bin/env node
// Downloads titles from media/sources.json into media/src/<id>.mp4 (skips existing files).
// Usage: node scripts/fetch-sources.mjs [id ...]
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('media/sources.json', root), 'utf8'))
const wanted = process.argv.slice(2)
const titles = wanted.length ? manifest.titles.filter((t) => wanted.includes(t.id)) : manifest.titles
await mkdir(new URL('media/src/', root), { recursive: true })

for (const t of titles) {
  const dest = new URL(`media/src/${t.id}.mp4`, root)
  if (await stat(dest).then(() => true, () => false)) {
    console.log(`have  ${t.id}`)
    continue
  }
  const res = await fetch(t.url, { redirect: 'follow' })
  if (!res.ok) {
    console.error(`FAIL  ${t.id}: HTTP ${res.status}`)
    process.exitCode = 1
    continue
  }
  const part = new URL(`media/src/${t.id}.mp4.part`, root)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
  await rename(part, dest)
  console.log(`got   ${t.id} (${((await stat(dest)).size / 1e6).toFixed(1)} MB)`)
}
