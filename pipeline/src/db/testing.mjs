// Test helper: a pool on its own throwaway schema, or null when Postgres is not reachable
// (the DB tests then skip, so `node --test pipeline/` still passes without Docker).
import { randomBytes } from 'node:crypto'
import { migrate } from './migrate.mjs'
import { checkDb, createPool } from './pool.mjs'

export const SKIP = 'Postgres not reachable (docker compose -f pipeline/compose.yaml up -d db)'

export async function openTestDb({ migrated = true } = {}) {
  const admin = createPool({ max: 1 })
  if (await checkDb(admin)) {
    await admin.end()
    return null
  }
  const schema = `t_${randomBytes(6).toString('hex')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = createPool({ schema, max: 4 })
  if (migrated) await migrate(pool)
  return {
    pool,
    schema,
    async close() {
      await pool.end()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    },
  }
}
