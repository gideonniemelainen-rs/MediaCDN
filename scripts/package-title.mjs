#!/usr/bin/env node
// Packages media/src/<slug>.mp4 into an ABR ladder and writes HLS + DASH into origin/<slug>/.
// It picks the rungs from shared/src/ladder.ts for the source's height and runs scripts/package.sh with them,
// so the ladder lives in one place and the script holds no table.
// Usage: node scripts/package-title.mjs <slug> [--quick]   (--quick: 360p + 720p only)
// Env: INPUT=<file> and OUT=<dir> override the default paths; PROGRESS=<url> is passed on to ffmpeg's -progress.
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeSpec, selectRungs } from '../shared/src/ladder.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** @param {string[]} argv */
export function parseArgs(argv) {
  const quick = argv.includes('--quick')
  const rest = argv.filter((a) => a !== '--quick')
  const unknown = rest.filter((a) => a.startsWith('-'))
  if (unknown.length || rest.length !== 1) throw new Error('usage: node scripts/package-title.mjs <slug> [--quick]')
  return { slug: rest[0], quick }
}

/** Height in pixels of the first video stream of `file`. */
export function sourceHeight(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  const height = Number.parseInt(out, 10)
  if (!(height > 0)) throw new Error(`could not read the height of ${file}`)
  return height
}

/** Package one title; returns the exit status of package.sh. */
export function packageTitle({ slug, quick = false, env = process.env }) {
  const input = env.INPUT || join(root, 'media/src', `${slug}.mp4`)
  const height = sourceHeight(input)
  const rungs = selectRungs(height, { quick })
  const run = spawnSync('bash', [join(root, 'scripts/package.sh'), slug], {
    stdio: 'inherit',
    env: { ...env, INPUT: input, RUNGS: encodeSpec(rungs), SRC_H: String(height) },
  })
  return run.status ?? 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  try {
    process.exit(packageTitle(args))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
