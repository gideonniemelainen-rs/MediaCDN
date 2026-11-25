#!/usr/bin/env node
// Upload server for the local pipeline: accepts a video, runs it through probe, validate,
// normalise, package, verify and publish, and streams job progress to the /upload/ page.
// usage: node pipeline/bin/serve.mjs [--port 8790] [--work dir] [--origin dir]
// env:   PIPELINE_ALLOWED_ORIGINS=http://localhost:5173,...  (browser origins allowed to call it)
//        DATABASE_URL=postgres://...  (default: the compose db; start it with docker compose -f pipeline/compose.yaml up -d db)
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDb, createPool } from '../src/db/pool.mjs'
import { migrate } from '../src/db/migrate.mjs'
import { createBenchmarks } from '../src/db/benchmarks.mjs'
import { createSettings } from '../src/db/settings.mjs'
import { createUploads } from '../src/db/uploads.mjs'
import { createSessions } from '../src/db/sessions.mjs'
import { createUsers, seedAdmin } from '../src/db/users.mjs'
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

const pool = createPool()
const dbError = await checkDb(pool)
if (dbError) {
  console.error(`database not reachable (${dbError}). Start it with: docker compose -f pipeline/compose.yaml up -d db`)
  process.exit(1)
}
await migrate(pool)
const users = createUsers(pool)
const sessions = createSessions(pool)
if (await seedAdmin(users)) console.warn('created the default user admin / admin')
const admin = await users.findByName('admin')
if (admin?.mustChangePassword) console.warn('WARNING: the admin account still has its default password. Sign in and change it.')
await sessions.purgeExpired()

const auth = { users, sessions, dbStatus: () => checkDb(pool) }
// Jobs from before accounts existed have no owner; they belong to admin.
const history = {
  benchmarks: createBenchmarks(pool),
  uploads: createUploads(pool, { fallbackUserId: async () => (await users.findByName('admin'))?.id ?? null }),
}
const { server } = await createPipelineServer({ work: opts.work, origin: opts.origin, profile, steps, auth, history, settings: createSettings(pool), allowedOrigins })

server.listen(opts.port, '127.0.0.1', () => {
  console.log(`pipeline on http://127.0.0.1:${opts.port}/api/pipeline  (work ${opts.work}, origin ${opts.origin})`)
})
