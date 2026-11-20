#!/usr/bin/env node
// Upload server for the local pipeline: accepts a video, runs it through probe, validate,
// normalise, package, verify and publish, and streams job progress to the /upload/ page.
// usage: node pipeline/bin/serve.mjs [--port 8790] [--work dir] [--origin dir]
// env:   PIPELINE_ALLOWED_ORIGINS=http://localhost:5173,...  (browser origins allowed to call it)
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ORIGINS, createPipelineServer } from '../src/server.mjs'
import { createSteps } from '../src/steps.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const opts = { port: 8790, work: join(root, 'work'), origin: resolve(root, '../origin') }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') opts.port = Number(argv[++i])
  else if (argv[i] === '--work') opts.work = resolve(argv[++i])
  else if (argv[i] === '--origin') opts.origin = resolve(argv[++i])
}

const profile = JSON.parse(await readFile(join(root, 'profiles/default.json'), 'utf8'))
const allowedOrigins = process.env.PIPELINE_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()) ?? DEFAULT_ORIGINS
const steps = createSteps({ profile, work: opts.work, origin: opts.origin })
const { server } = await createPipelineServer({ work: opts.work, origin: opts.origin, profile, steps, allowedOrigins })

server.listen(opts.port, '127.0.0.1', () => {
  console.log(`pipeline on http://127.0.0.1:${opts.port}/api/pipeline  (work ${opts.work}, origin ${opts.origin})`)
})
