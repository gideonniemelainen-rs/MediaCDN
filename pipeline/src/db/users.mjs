import { hashPassword } from '../auth.mjs'

const COLS = 'id, username, password_hash, role, must_change_password, created_at'
const toUser = (r) =>
  r && { id: r.id, username: r.username, passwordHash: r.password_hash, role: r.role, mustChangePassword: r.must_change_password }

export function createUsers(pool) {
  return {
    async findByName(username) {
      const { rows } = await pool.query(`SELECT ${COLS} FROM users WHERE lower(username) = lower($1)`, [username])
      return toUser(rows[0])
    },
    async findById(id) {
      const { rows } = await pool.query(`SELECT ${COLS} FROM users WHERE id = $1`, [id])
      return toUser(rows[0])
    },
    async count() {
      return Number((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n)
    },
    async create({ username, password, role = 'user', mustChangePassword = false }) {
      const { rows } = await pool.query(
        `INSERT INTO users (username, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
        [username, await hashPassword(password), role, mustChangePassword],
      )
      return toUser(rows[0])
    },
    async setPassword(id, password) {
      await pool.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [id, await hashPassword(password)])
    },
  }
}

/** First start: an empty users table gets admin/admin, flagged for a password change. Returns true if it seeded. */
export async function seedAdmin(users) {
  if ((await users.count()) > 0) return false
  await users.create({ username: 'admin', password: 'admin', role: 'admin', mustChangePassword: true })
  return true
}
