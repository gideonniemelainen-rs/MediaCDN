// Applies db/migrations/NNN-name.sql in order, once each, one transaction per file. An advisory lock
// serialises two servers (or two test files) starting at once.
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('./migrations/', import.meta.url))
const LOCK_KEY = 727401 // arbitrary; shared by every process that migrates this database

export async function migrate(pool, dir = DIR) {
  const files = (await readdir(dir)).filter((f) => /^\d{3}-.+\.sql$/.test(f)).sort()
  const client = await pool.connect()
  const applied = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version))
    for (const file of files) {
      const version = file.slice(0, 3)
      if (done.has(version)) continue
      await client.query('BEGIN')
      try {
        await client.query(await readFile(dir + file, 'utf8'))
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
        await client.query('COMMIT')
        applied.push(version)
      } catch (e) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${e.message}`)
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {})
    client.release()
  }
  return applied
}
