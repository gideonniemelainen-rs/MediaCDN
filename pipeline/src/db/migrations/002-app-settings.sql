-- Application settings the GUI can change: one row per group (deliveries, packaging, player, origin), holding only the
-- fields someone has overridden (see shared/src/settings.ts). Distinct from `settings` in 001, which is per-user.
--
-- Rows are never deleted: resetting a field rewrites the row, so `revision` only ever goes up. It comes from one
-- sequence shared by every group, so the highest revision is a cheap "has anything changed" for the clients that poll.
-- The group names are not constrained here; shared/src/settings.ts is the one list and the repository enforces it.

CREATE SEQUENCE app_settings_revision;

CREATE TABLE app_settings (
  group_name text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}',
  revision   bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL
);
