#!/usr/bin/env node
// Generates ad-style test assets and packages them like content:
//   media/src/ads/<id>.mp4        encoded source (git-ignored)
//   origin/ads/<id>/              HLS + DASH ladder (scripts/package-title.mjs) plus ad.mp4, a progressive copy for VAST/CSAI
//   origin/ads/ads.json           the inventory the app reads
//
// Two kinds: synthetic (testsrc2, distinct hue, N blocks for "ad N", moving progress marker, own tone)
// and cuts of our CC BY titles with a sponsor-coloured frame. No text is drawn in the video: the host
// ffmpeg has no drawtext, so ads are told apart by colour, block count, tone and the app's own badge.
//
// Usage: node scripts/make-ads.mjs [id ...]     (default: all)
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HLS_MASTER } from '../shared/src/title-layout.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FPS = 24
const W = 1280
const H = 720

const ADS = [
  { id: 'bumper-6', kind: 'synthetic', label: 'Bumper (6 s)', durationSec: 6, hue: 200, blocks: 1, tone: 523 },
  { id: 'spot-15', kind: 'synthetic', label: 'Spot (15 s)', durationSec: 15, hue: 40, blocks: 2, tone: 392 },
  { id: 'spot-30', kind: 'synthetic', label: 'Spot (30 s)', durationSec: 30, hue: 120, blocks: 3, tone: 330 },
  {
    id: 'cut-llamigos', kind: 'cut', label: 'Sponsored: Llamigos cut (15 s)', durationSec: 15,
    from: 'llamigos', start: 30, brand: '0xe63946',
    attribution: '(CC) Blender Foundation | caminandes.com, CC BY 3.0, cut and re-encoded',
  },
  {
    id: 'cut-agent-327', kind: 'cut', label: 'Sponsored: Agent 327 cut (15 s)', durationSec: 15,
    from: 'agent-327', start: 60, brand: '0x2a9d8f',
    attribution: '(CC) Blender Foundation | agent327.com, CC BY 3.0, cut and re-encoded',
  },
]

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] })
const ffmpeg = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

// Loudness matched to the content pipeline (-16 LUFS), so ads are not louder than the stream.
const AUDIO_NORM = 'aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000'
const ENCODE = [
  '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
  '-crf', '20', '-g', String(FPS * 4), '-keyint_min', String(FPS * 4), '-sc_threshold', '0',
  '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart',
]

function synthetic(ad, out) {
  const d = ad.durationSec
  const blocks = Array.from({ length: ad.blocks }, (_, k) => `drawbox=x=${60 + k * 90}:y=60:w=70:h=70:color=white:t=fill`).join(',')
  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=${d}`,
    '-f', 'lavfi', '-i', `color=c=white:s=96x48:r=${FPS}:d=${d}`,
    '-f', 'lavfi', '-i', `sine=f=${ad.tone}:r=48000:d=${d}`,
    '-filter_complex',
    `[0:v]hue=h=${ad.hue},${blocks}[bg];[bg][1:v]overlay=x='(W-w)*t/${d}':y=H-72:shortest=1[v];[2:a]volume=0.5,${AUDIO_NORM}[a]`,
    '-map', '[v]', '-map', '[a]', ...ENCODE, '-t', String(d), out,
  ])
}

function cut(ad, out) {
  const src = join(root, 'media/src', `${ad.from}.mp4`)
  if (!existsSync(src)) throw new Error(`missing ${src} (run: node scripts/fetch-sources.mjs ${ad.from})`)
  const d = ad.durationSec
  const frame = `drawbox=x=0:y=0:w=iw:h=48:color=${ad.brand}@0.9:t=fill,drawbox=x=0:y=ih-48:w=iw:h=48:color=${ad.brand}@0.9:t=fill`
  ffmpeg([
    '-ss', String(ad.start), '-t', String(d), '-i', src,
    '-f', 'lavfi', '-i', `color=c=white:s=64x24:r=${FPS}:d=${d}`,
    '-filter_complex',
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},setsar=1,${frame}[bg];` +
      `[bg][1:v]overlay=x='(W-w)*t/${d}':y=H-36:shortest=1,fade=t=out:st=${d - 1}:d=1[v];` +
      `[0:a:0]afade=t=out:st=${d - 1}:d=1,${AUDIO_NORM}[a]`,
    '-map', '[v]', '-map', '[a]', ...ENCODE, '-t', String(d), out,
  ])
}

const wanted = process.argv.slice(2)
const todo = wanted.length ? ADS.filter((a) => wanted.includes(a.id)) : ADS
if (wanted.length && todo.length !== wanted.length) throw new Error(`unknown id in: ${wanted.join(' ')}`)

mkdirSync(join(root, 'media/src/ads'), { recursive: true })
for (const ad of todo) {
  const src = join(root, 'media/src/ads', `${ad.id}.mp4`)
  console.log(`== ${ad.id}: ${ad.label}`)
  if (ad.kind === 'synthetic') synthetic(ad, src)
  else cut(ad, src)
  run('node', [join(root, 'scripts/package-title.mjs'), `ads/${ad.id}`])
  // packaging recreates the folder, so the progressive copy goes in afterwards.
  copyFileSync(src, join(root, 'origin/ads', ad.id, 'ad.mp4'))
}

// The inventory always lists every ad that is fully built, not just the ones generated this run.
const built = ADS.filter((a) => existsSync(join(root, 'origin/ads', a.id, HLS_MASTER)) && existsSync(join(root, 'origin/ads', a.id, 'ad.mp4')))
const inventory = {
  version: 1,
  ads: built.map((a) => ({
    id: a.id,
    label: a.label,
    kind: a.kind,
    durationSec: a.durationSec,
    mp4: `/ads/${a.id}/ad.mp4`,
    hls: `/ads/${a.id}/${HLS_MASTER}`,
    ...(a.attribution ? { attribution: a.attribution } : {}),
  })),
}
mkdirSync(join(root, 'origin/ads'), { recursive: true })
writeFileSync(join(root, 'origin/ads/ads.json'), JSON.stringify(inventory, null, 2) + '\n')
console.log(`\n${built.length} ads in origin/ads/ads.json: ${built.map((a) => a.id).join(', ')}`)
