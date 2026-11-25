// Application settings (see db/migrations/002-app-settings.sql and shared/src/settings.ts). One row per group holding the
// overrides someone has set. Every write goes through the shared validator, so the table can never hold a value the
// schema rejects, and is guarded by a per-group revision so two tabs cannot silently overwrite each other.
import { GROUP_NAMES, fieldOf, isGroupName, validateGroup } from '../../../shared/src/settings.ts'

/** A write was refused because the stored revision is not the one the caller read. The API answers 409. */
export class RevisionConflict extends Error {
  status = 409
  constructor(group, expected, actual) {
    super(`settings group "${group}" changed (you have revision ${expected}, it is at ${actual}); reload and try again`)
    this.group = group
    this.expected = expected
    this.actual = actual
  }
}

/** The value is not valid for its group. The API answers 400 with the per-field `errors`. */
export class SettingsInvalid extends Error {
  status = 400
  constructor(message, errors = {}) {
    super(message)
    this.errors = errors
  }
}

const lockKey = (group) => `app_settings:${group}`

export function createSettings(pool) {
  function checkGroup(group) {
    if (!isGroupName(group)) throw new SettingsInvalid(`unknown settings group "${group}"`)
  }

  /** Runs `change(current)` under a lock on the group and stores its result with a new revision. */
  async function write(group, change, { userId = null, ifRevision } = {}) {
    checkGroup(group)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(group)])
      const row = (await client.query('SELECT value, revision FROM app_settings WHERE group_name = $1', [group])).rows[0]
      const current = row ? { value: row.value, revision: Number(row.revision) } : { value: {}, revision: 0 }
      if (ifRevision !== undefined && ifRevision !== current.revision) throw new RevisionConflict(group, ifRevision, current.revision)
      const next = change(current.value)
      if (next === null) {
        await client.query('COMMIT')
        return current // nothing to change: no new revision
      }
      const { rows } = await client.query(
        `INSERT INTO app_settings (group_name, value, revision, updated_by) VALUES ($1, $2, nextval('app_settings_revision'), $3)
         ON CONFLICT (group_name) DO UPDATE SET value = EXCLUDED.value, revision = EXCLUDED.revision, updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING value, revision`,
        [group, next, userId],
      )
      await client.query('COMMIT')
      return { value: rows[0].value, revision: Number(rows[0].revision) }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  return {
    /** Every group's overrides and revision, and the highest revision (0 when nothing has been set). */
    async all() {
      const { rows } = await pool.query('SELECT group_name, value, revision FROM app_settings')
      const overrides = {}
      const revisions = {}
      let revision = 0
      for (const g of GROUP_NAMES) {
        const row = rows.find((r) => r.group_name === g)
        if (!row) continue
        overrides[g] = row.value
        revisions[g] = Number(row.revision)
        revision = Math.max(revision, Number(row.revision))
      }
      return { revision, overrides, revisions }
    },

    /** One group's overrides and revision (`{}` and 0 when it has never been set). */
    async get(group) {
      checkGroup(group)
      const row = (await pool.query('SELECT value, revision FROM app_settings WHERE group_name = $1', [group])).rows[0]
      return row ? { value: row.value, revision: Number(row.revision) } : { value: {}, revision: 0 }
    },

    /**
     * Replaces a group's overrides with `value`. With `ifRevision`, refuses (RevisionConflict) unless that is the
     * group's current revision (0 for a group never set). Returns the stored value and its new revision.
     */
    async set(group, value, opts = {}) {
      checkGroup(group)
      const checked = validateGroup(group, value)
      if (!checked.ok) throw new SettingsInvalid('invalid settings', checked.errors)
      return write(group, () => checked.value, opts)
    },

    /** Removes one field's override so it falls back to its default. Does nothing, and bumps no revision, if it was not set. */
    async unset(group, field, opts = {}) {
      checkGroup(group)
      if (!fieldOf(group, field)) throw new SettingsInvalid(`unknown setting "${field}" in group "${group}"`, { [field]: 'unknown setting' })
      return write(
        group,
        (current) => {
          if (!Object.hasOwn(current, field)) return null
          const { [field]: _removed, ...rest } = current
          return rest
        },
        opts,
      )
    },
  }
}
