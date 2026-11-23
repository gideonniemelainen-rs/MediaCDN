// Saved benchmark runs: the run, one row per quadrant (the figures you compare and sort on as real
// columns), and the telemetry blob that lets the charts be rebuilt on demand.
import { METRICS } from '../benchmarks.mjs'

const MAX_PAGE = 100
const ms = (d) => (d ? d.getTime() : null)
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const isRunId = (id) => new RegExp(`^${UUID}$`).test(id)

/** Keyset cursor `<startedAt ms>_<run id>`. */
export function parseCursor(value) {
  const m = new RegExp(`^(\\d{1,15})_(${UUID})$`).exec(String(value ?? ''))
  return m ? { at: Number(m[1]), id: m[2] } : null
}

const runRow = (r) => ({
  id: r.id,
  label: r.label,
  startedAt: ms(r.started_at),
  endedAt: ms(r.ended_at),
  env: r.env,
  owner: r.owner,
})
const sessionRow = (r) => ({
  slot: r.slot,
  streamId: r.stream_id,
  delivery: r.delivery,
  ...Object.fromEntries(METRICS.map(([key, col]) => [key, r[col]])),
})

export function createBenchmarks(pool) {
  return {
    /** One transaction: a failed blob write leaves no run behind. Returns the new run's id. */
    async create(userId, { label, startedAt, endedAt, env, sessions, blob }) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const { rows } = await client.query(
          `INSERT INTO benchmark_runs (user_id, label, started_at, ended_at, env)
           VALUES ($1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0), $5) RETURNING id`,
          [userId, label, startedAt, endedAt, JSON.stringify(env)],
        )
        const id = rows[0].id
        const cols = METRICS.map(([, col]) => col)
        for (const s of sessions) {
          await client.query(
            `INSERT INTO benchmark_sessions (run_id, slot, stream_id, delivery, ${cols.join(', ')})
             VALUES ($1, $2, $3, $4, ${cols.map((_, i) => `$${i + 5}`).join(', ')})`,
            [id, s.slot, s.streamId, s.delivery, ...METRICS.map(([key]) => s[key])],
          )
        }
        await client.query(
          `INSERT INTO artifacts (owner_kind, owner_id, kind, schema_version, json, bytes)
           VALUES ('benchmark_run', $1, 'telemetry-events', 1, $2, $3)`,
          [id, blob.json, blob.bytes],
        )
        await client.query('COMMIT')
        return id
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    },

    /** Newest first; never reads the blobs. */
    async list(user, { before, limit = 25 } = {}) {
      const n = Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE)
      const cur = parseCursor(before)
      const params = []
      const where = []
      if (user.role !== 'admin') where.push(`r.user_id = $${params.push(user.id)}`)
      if (cur) where.push(`(r.started_at, r.id) < (to_timestamp($${params.push(cur.at)} / 1000.0), $${params.push(cur.id)})`)
      const { rows } = await pool.query(
        `SELECT r.id, r.label, r.started_at, r.ended_at, r.env, o.username AS owner,
                COALESCE((SELECT json_agg(json_build_object('slot', s.slot, 'streamId', s.stream_id, 'delivery', s.delivery) ORDER BY s.slot)
                            FROM benchmark_sessions s WHERE s.run_id = r.id), '[]') AS sessions
           FROM benchmark_runs r JOIN users o ON o.id = r.user_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY r.started_at DESC, r.id DESC LIMIT ${n + 1}`,
        params,
      )
      const page = rows.slice(0, n).map((r) => ({ ...runRow(r), sessions: r.sessions }))
      const last = page[page.length - 1]
      return { runs: page, next: rows.length > n ? `${last.startedAt}_${last.id}` : null }
    },

    /** The run with its quadrants and the list of blobs it has, or undefined if missing or not the user's. */
    async get(user, id) {
      if (!isRunId(id)) return undefined
      const params = [id]
      const owned = user.role === 'admin' ? '' : `AND r.user_id = $${params.push(user.id)}`
      const { rows } = await pool.query(
        `SELECT r.id, r.label, r.started_at, r.ended_at, r.env, o.username AS owner
           FROM benchmark_runs r JOIN users o ON o.id = r.user_id WHERE r.id = $1 ${owned}`,
        params,
      )
      if (!rows[0]) return undefined
      const [sessions, artifacts] = await Promise.all([
        pool.query('SELECT * FROM benchmark_sessions WHERE run_id = $1 ORDER BY slot', [id]),
        pool.query(`SELECT kind, schema_version, bytes FROM artifacts WHERE owner_kind = 'benchmark_run' AND owner_id = $1 ORDER BY kind`, [id]),
      ])
      return {
        ...runRow(rows[0]),
        sessions: sessions.rows.map(sessionRow),
        artifacts: artifacts.rows.map((a) => ({ kind: a.kind, schemaVersion: a.schema_version, bytes: a.bytes })),
      }
    },

    async getArtifact(user, id, kind) {
      if (!isRunId(id)) return undefined
      const params = [id, kind]
      const owned = user.role === 'admin' ? '' : `AND r.user_id = $${params.push(user.id)}`
      const { rows } = await pool.query(
        `SELECT a.schema_version, a.json FROM artifacts a JOIN benchmark_runs r ON r.id::text = a.owner_id
          WHERE a.owner_kind = 'benchmark_run' AND a.owner_id = $1 AND a.kind = $2 ${owned}`,
        params,
      )
      return rows[0] && { schemaVersion: rows[0].schema_version, json: rows[0].json }
    },

    /** Deletes the run, its quadrants and its blobs. Returns whether anything was deleted. */
    async remove(user, id) {
      if (!isRunId(id)) return false
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const params = [id]
        const owned = user.role === 'admin' ? '' : `AND user_id = $${params.push(user.id)}`
        const { rowCount } = await client.query(`DELETE FROM benchmark_runs WHERE id = $1 ${owned}`, params)
        if (rowCount) await client.query(`DELETE FROM artifacts WHERE owner_kind = 'benchmark_run' AND owner_id = $1`, [id])
        await client.query('COMMIT')
        return rowCount > 0
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    },
  }
}
