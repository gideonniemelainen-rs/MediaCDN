import { SESSION_DAYS, hashToken } from '../auth.mjs'

export function createSessions(pool) {
  return {
    async create(userId, token, kind = 'cookie') {
      await pool.query(
        `INSERT INTO sessions (token_hash, user_id, kind, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
        [hashToken(token), userId, kind, SESSION_DAYS],
      )
    },
    /** The user id for a live token; also pushes the expiry out (sliding window). */
    async touch(token) {
      const { rows } = await pool.query(
        `UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2)
          WHERE token_hash = $1 AND expires_at > now() RETURNING user_id`,
        [hashToken(token), SESSION_DAYS],
      )
      return rows[0]?.user_id
    },
    async destroy(token) {
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)])
    },
    /** After a password change: every session for the user except the one in use. */
    async destroyOthers(userId, keepToken) {
      await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, hashToken(keepToken)])
    },
    async purgeExpired() {
      await pool.query('DELETE FROM sessions WHERE expires_at <= now()')
    },
  }
}
