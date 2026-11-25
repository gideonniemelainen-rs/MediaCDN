// Workflow run history: one row per run. The run files under work/runs stay the live source (SSE and restart recovery);
// this is the queryable history, shaped like the upload history (db/uploads.mjs).
import { publicRun } from '../runs.mjs'
import { errorCodeOf, parseCursor } from './uploads.mjs'

const MAX_PAGE = 100

const ms = (d) => (d ? d.getTime() : null)
const toRow = (r) => ({
  id: r.id,
  workflow: r.workflow,
  params: r.params,
  dryRun: r.dry_run,
  status: r.status,
  createdAt: ms(r.created_at),
  endedAt: ms(r.ended_at),
  durationMs: r.duration_ms,
  errorCode: r.error_code,
  owner: r.owner,
})
const cursorOf = (row) => `${row.createdAt}_${row.id}`

/** A user sees their own runs; an admin sees everyone's. A run with no owner (started by the system) is not recorded. */
export function createRuns(pool) {
  return {
    async upsert(job) {
      const userId = job.meta.userId
      if (!userId) return false
      const terminal = job.status === 'success' || job.status === 'failed'
      const endedAt = terminal ? Math.max(job.createdAt, ...job.stages.map((s) => s.endedAt ?? 0)) : null
      await pool.query(
        `INSERT INTO workflow_runs (id, user_id, workflow, params, dry_run, status, created_at, ended_at, duration_ms, error_code, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0), $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status, ended_at = EXCLUDED.ended_at, duration_ms = EXCLUDED.duration_ms,
           error_code = EXCLUDED.error_code, snapshot = EXCLUDED.snapshot`,
        [
          job.id, userId, job.meta.workflow, JSON.stringify(job.meta.params ?? {}), Boolean(job.meta.dryRun), job.status,
          job.createdAt, endedAt, endedAt === null ? null : endedAt - job.createdAt, errorCodeOf(job), JSON.stringify(publicRun(job)),
        ],
      )
      return true
    },

    /** Newest first. `before` is a cursor from a previous page's `next`; `workflow` narrows to one workflow. */
    async list(user, { before, limit = 25, workflow } = {}) {
      const n = Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE)
      const cur = parseCursor(before)
      const params = []
      const where = []
      if (user.role !== 'admin') where.push(`r.user_id = $${params.push(user.id)}`)
      if (workflow) where.push(`r.workflow = $${params.push(String(workflow))}`)
      if (cur) where.push(`(r.created_at, r.id) < (to_timestamp($${params.push(cur.at)} / 1000.0), $${params.push(cur.id)})`)
      const { rows } = await pool.query(
        `SELECT r.id, r.workflow, r.params, r.dry_run, r.status, r.created_at, r.ended_at, r.duration_ms, r.error_code, o.username AS owner
           FROM workflow_runs r JOIN users o ON o.id = r.user_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY r.created_at DESC, r.id DESC LIMIT ${n + 1}`,
        params,
      )
      const page = rows.slice(0, n).map(toRow)
      return { runs: page, next: rows.length > n ? cursorOf(page[page.length - 1]) : null }
    },

    /** One run with its job snapshot, or undefined if it is missing or not the user's. */
    async get(user, id) {
      const params = [id]
      const owned = user.role === 'admin' ? '' : `AND r.user_id = $${params.push(user.id)}`
      const { rows } = await pool.query(
        `SELECT r.id, r.workflow, r.params, r.dry_run, r.status, r.created_at, r.ended_at, r.duration_ms, r.error_code, r.snapshot, o.username AS owner
           FROM workflow_runs r JOIN users o ON o.id = r.user_id WHERE r.id = $1 ${owned}`,
        params,
      )
      return rows[0] ? { ...toRow(rows[0]), job: rows[0].snapshot } : undefined
    },
  }
}
