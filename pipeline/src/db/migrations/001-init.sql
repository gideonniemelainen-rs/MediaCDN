-- Initial schema: accounts and sessions, upload history, benchmark runs and the JSON blobs that
-- rebuild charts. Columns hold what is filtered, sorted or aggregated; jsonb holds what is only rendered.

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             text NOT NULL,
  password_hash        text NOT NULL,
  role                 text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  must_change_password boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'cookie' CHECK (kind IN ('cookie', 'bearer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE uploads (
  id            text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id),
  source_name   text NOT NULL,
  source_bytes  bigint,
  source_sha256 text,
  status        text NOT NULL,
  output_id     text,
  created_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  duration_ms   integer,
  error_code    text,
  snapshot      jsonb NOT NULL
);
CREATE INDEX uploads_user_created_idx ON uploads (user_id, created_at DESC);

CREATE TABLE upload_stages (
  upload_id  text NOT NULL REFERENCES uploads (id) ON DELETE CASCADE,
  stage      text NOT NULL,
  status     text NOT NULL,
  started_at timestamptz,
  ended_at   timestamptz,
  summary    jsonb,
  PRIMARY KEY (upload_id, stage)
);

CREATE TABLE benchmark_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  label      text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL,
  ended_at   timestamptz NOT NULL,
  env        jsonb NOT NULL DEFAULT '{}',
  transport  text
);
CREATE INDEX benchmark_runs_user_started_idx ON benchmark_runs (user_id, started_at DESC);

CREATE TABLE benchmark_sessions (
  run_id                  uuid NOT NULL REFERENCES benchmark_runs (id) ON DELETE CASCADE,
  slot                    integer NOT NULL,
  stream_id               text NOT NULL,
  delivery                text NOT NULL,
  startup_ms              double precision,
  rebuffer_count          integer,
  rebuffer_ratio          double precision,
  avg_bitrate_kbps        double precision,
  mean_segment_latency_ms double precision,
  throughput_kbps         double precision,
  errors                  integer,
  PRIMARY KEY (run_id, slot)
);

CREATE TABLE artifacts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind     text NOT NULL CHECK (owner_kind IN ('benchmark_run', 'upload')),
  owner_id       text NOT NULL,
  kind           text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  json           jsonb NOT NULL,
  bytes          integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_owner_idx ON artifacts (owner_kind, owner_id);

CREATE TABLE settings (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key     text NOT NULL,
  value   jsonb NOT NULL,
  PRIMARY KEY (user_id, key)
);
