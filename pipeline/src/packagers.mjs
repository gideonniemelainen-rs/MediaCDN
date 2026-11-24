// How the package stage runs a packager. Pure: it builds the command, the stage spawns it.
//   ffmpeg  scripts/package.sh on the host (ffmpeg's DASH muxer writes HLS and DASH together)
//   shaka   scripts/package-shaka.sh in the worker image (ffmpeg encodes the rungs, Shaka Packager
//           writes CMAF HLS and DASH). The image is the only place Shaka Packager is installed.
import { dirname, join } from 'node:path'
import { formatRungs } from './ladder.mjs'

export const PACKAGERS = ['ffmpeg', 'shaka']
export const DEFAULT_IMAGE = 'mediacdn-pipeline:dev'

export function packagerKind(value) {
  const kind = value || 'ffmpeg'
  if (!PACKAGERS.includes(kind)) throw new Error(`PIPELINE_PACKAGER must be one of ${PACKAGERS.join(', ')}, got "${kind}"`)
  return kind
}

/**
 * @param {object} o
 * @param {'ffmpeg'|'shaka'} o.kind
 * @param {string} o.mezzanine  host path of the mezzanine
 * @param {string} o.stage      host path of the (existing) staging directory
 * @param {string} o.outputId
 * @param {{height:number,kbps:number}[]} o.rungs  used by shaka only
 * @param {number|null} [o.crf]                    shaka only: encode each rung at this constant quality, capped by its kbps (VBV); without it kbps is the target rate
 * @param {number} o.sourceHeight                  used by shaka only, for the log line
 * @returns {{ cmd: string, args: string[], env: Record<string,string|undefined> }}
 */
export function packageCommand({ kind, mezzanine, stage, outputId, rungs, crf, sourceHeight, scriptsDir, packageScript, image = DEFAULT_IMAGE, uid, gid, env = process.env }) {
  if (kind === 'ffmpeg') {
    return { cmd: 'bash', args: [packageScript, outputId], env: { ...env, INPUT: mezzanine, OUT: stage, PROGRESS: 'pipe:1' } }
  }
  const e = (k, v) => ['-e', `${k}=${v}`]
  return {
    cmd: 'docker',
    args: [
      'run', '--rm',
      // Untrusted media: no network, no capabilities, and the host's own user so output is not root-owned.
      '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      ...(uid !== undefined && gid !== undefined ? ['--user', `${uid}:${gid}`] : []),
      '-v', `${dirname(mezzanine)}:/in:ro`,
      '-v', `${stage}:/out`,
      '-v', `${scriptsDir}:/scripts:ro`,
      ...e('INPUT', `/in/${mezzanine.split('/').pop()}`),
      ...e('OUT', '/out'),
      ...e('PROGRESS', 'pipe:1'),
      ...e('RUNGS', formatRungs(rungs)),
      ...(crf ? e('CRF', crf) : []),
      ...e('SRC_H', sourceHeight),
      ...e('SLUG', outputId),
      '--entrypoint', 'bash',
      image,
      join('/scripts', 'package-shaka.sh'),
    ],
    env,
  }
}

/** A readable reason for a failed docker run, with the likely fix when it is a setup problem. */
export function explainPackagerFailure(kind, { code, stderrTail = [], spawnError }) {
  if (kind === 'shaka') {
    if (spawnError?.code === 'ENOENT') return 'docker was not found: PIPELINE_PACKAGER=shaka runs the packager in the worker image, so Docker must be installed'
    const text = stderrTail.join(' | ')
    if (/Unable to find image|pull access denied|No such image/i.test(text)) return `the worker image is missing: build it with "docker build -t ${DEFAULT_IMAGE} pipeline/"`
    if (/Cannot connect to the Docker daemon|Is the docker daemon running/i.test(text)) return 'Docker is not running'
  }
  return stderrTail.slice(-3).join(' | ') || (spawnError ? spawnError.message : `${kind === 'shaka' ? 'package-shaka.sh' : 'package.sh'} exited ${code}`)
}
