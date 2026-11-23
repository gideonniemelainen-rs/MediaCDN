// One pg Pool per process. Config comes from DATABASE_URL; the default matches pipeline/compose.yaml
// (published on loopback only).
import pg from 'pg'

export const DEFAULT_DATABASE_URL = 'postgres://mediacdn:mediacdn@127.0.0.1:5432/mediacdn'

/** `schema` pins search_path, which is how tests get an isolated copy of every table. */
export function createPool({ url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, schema, max = 5 } = {}) {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 3000,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  })
  // An idle client erroring (server restart) must not crash the process.
  pool.on('error', (e) => console.error(`postgres: ${e.message}`))
  return pool
}

/** Resolves to an error message, or null when a query round-trips. */
export async function checkDb(pool) {
  try {
    await pool.query('SELECT 1')
    return null
  } catch (e) {
    return e.code === 'ECONNREFUSED' || !e.message ? 'connection refused' : e.message
  }
}
