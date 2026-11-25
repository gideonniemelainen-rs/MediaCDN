// Runs a command as a stage of a run: stdout and stderr lines go to the stage log, a non-zero exit fails the stage with the
// last stderr lines. The command is `spawn(cmd, args)`, never a shell string, and the child's environment is PATH plus
// exactly what the workflow passes, so a run cannot read the server's DATABASE_URL or anything else it was not given.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { StageError } from '../run.mjs'

const KEEP = 2000

/**
 * @param {object} o
 * @param {string} o.cmd
 * @param {string[]} [o.args]
 * @param {string} [o.cwd]
 * @param {Record<string, string>} [o.env]
 * @param {{ log: (line: string) => void }} o.h
 * @returns {Promise<{ lines: string[] }>} the stdout lines (the last 2000)
 */
export function spawnStage({ cmd, args = [], cwd, env = {}, h }) {
  return new Promise((resolve, reject) => {
    const lines = []
    const tail = []
    const child = spawn(cmd, args, { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    createInterface({ input: child.stdout }).on('line', (line) => {
      lines.push(line)
      if (lines.length > KEEP) lines.shift()
      h.log(line)
    })
    createInterface({ input: child.stderr }).on('line', (line) => {
      tail.push(line)
      if (tail.length > 20) tail.shift()
      h.log(line)
    })
    child.on('error', (e) => reject(new StageError('E_SPAWN', e.code === 'ENOENT' ? `${cmd} was not found` : e.message)))
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ lines })
      reject(new StageError('E_WORKFLOW_FAILED', tail.slice(-3).join(' | ') || (signal ? `${cmd} was stopped by ${signal}` : `${cmd} exited ${code}`)))
    })
  })
}
