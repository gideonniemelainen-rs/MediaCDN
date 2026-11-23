// Upload history: one row per pipeline job plus a row per stage. The job files under work/jobs stay
// the live source (SSE and restart recovery); this is the queryable history.
import { publicJob } from '../jobs.mjs'

const MAX_PAGE = 100

const ms = (d) => (d ? d.getTime() : null)
const toRow = (r) => ({
  id: r.id,
  name: r.source_name,
  status: r.status,
  bytes: r.source_bytes === null ? null : Number(r.source_bytes),
  sha256: r.source_sha256,
  outputId: r.output_id,
  createdAt: ms(r.created_at),
  endedAt: ms(r.ended_at),
  durationMs: r.duration_ms,
  errorCode: r.error_code,
  owner: r.owner,
})

/** The failing stage's stable code (E_...), if the job failed with one. */
export const errorCodeOf = (job) => job.stages.find((s) => s.status === 'failed')?.result?.code ?? null

/** Cursor for keyset paging: `<createdAt ms>_<id>`. */
const cursorOf = (row) => `${row.createdAt}_${row.id}`
export function parseCursor(value) {
  const m = /^(\d{1,15})_([0-9a-f]{8})$/.exec(String(value ?? ''))
  return m ? { at: Number(m[1]), id: m[2] } : null
}

/**
 * `fallbackUserId` owns jobs that predate accounts (no meta.userId). Without one such jobs are skipped.
 * A user sees their own uploads; an admin sees everyone's.
 */
export function createUploads(pool, { fallbackUserId = async () => null } = {}) {
  return {
    async upsert(job) {
      const userId = job.meta.userId ?? (await fallbackUserId())
      if (!userId) return false
      const terminal = job.status === 'success' || job.status === 'failed'
      const endedAt = terminal ? Math.max(job.createdAt, ...job.stages.map((s) => s.endedAt ?? 0)) : null
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO uploads (id, user_id, source_name, source_bytes, source_sha256, status, output_id,
                                created_at, ended_at, duration_ms, error_code, snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0), $10, $11, $12)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status, output_id = EXCLUDED.output_id, ended_at = EXCLUDED.ended_at,
             duration_ms = EXCLUDED.duration_ms, error_code = EXCLUDED.error_code, snapshot = EXCLUDED.snapshot`,
          [
            job.id, userId, job.meta.name ?? 'upload', job.meta.bytes ?? null, job.meta.sha256 ?? null, job.status,
            job.meta.outputId ?? null, job.createdAt, endedAt, endedAt === null ? null : endedAt - job.createdAt,
            errorCodeOf(job), JSON.stringify(publicJob(job)),
          ],
        )
        for (const s of job.stages) {
          await client.query(
            `INSERT INTO upload_stages (upload_id, stage, status, started_at, ended_at, summary)
             VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), $6)
             ON CONFLICT (upload_id, stage) DO UPDATE SET
               status = EXCLUDED.status, started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, summary = EXCLUDED.summary`,
            [job.id, s.id, s.status, s.startedAt, s.endedAt, JSON.stringify({ summary: s.summary, result: s.result })],
          )
        }
        await client.query('COMMIT')
        return true
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    },

    /** Newest first. `before` is a cursor from a previous page's `next`. */
    async list(user, { before, limit = 25 } = {}) {
      const n = Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE)
      const cur = parseCursor(before)
      const params = []
      const where = []
      if (user.role !== 'admin') where.push(`u.user_id = $${params.push(user.id)}`)
      if (cur) where.push(`(u.created_at, u.id) < (to_timestamp($${params.push(cur.at)} / 1000.0), $${params.push(cur.id)})`)
      const { rows } = await pool.query(
        `SELECT u.id, u.source_name, u.source_bytes, u.source_sha256, u.status, u.output_id, u.created_at, u.ended_at,
                u.duration_ms, u.error_code, o.username AS owner
           FROM uploads u JOIN users o ON o.id = u.user_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY u.created_at DESC, u.id DESC LIMIT ${n + 1}`,
        params,
      )
      const page = rows.slice(0, n).map(toRow)
      return { uploads: page, next: rows.length > n ? cursorOf(page[page.length - 1]) : null }
    },

    /** One upload with its job snapshot and stage rows, or undefined if it is missing or not the user's. */
    async get(user, id) {
      const params = [id]
      const owned = user.role === 'admin' ? '' : `AND u.user_id = $${params.push(user.id)}`
      const { rows } = await pool.query(
        `SELECT u.id, u.source_name, u.source_bytes, u.source_sha256, u.status, u.output_id, u.created_at, u.ended_at,
                u.duration_ms, u.error_code, u.snapshot, o.username AS owner
           FROM uploads u JOIN users o ON o.id = u.user_id WHERE u.id = $1 ${owned}`,
        params,
      )
      if (!rows[0]) return undefined
      return { ...toRow(rows[0]), job: rows[0].snapshot }
    },
  }
}
