-- Workflow run history: one row per run of a Workflow (package a title, upload to S3, the benchmark...). The run files
-- under work/runs stay the live source (SSE and restart recovery); this is the queryable history. As for uploads, the
-- columns hold what is filtered and sorted and the snapshot holds what is only rendered.
CREATE TABLE workflow_runs (
  id          text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id),
  workflow    text NOT NULL,
  params      jsonb NOT NULL DEFAULT '{}',
  dry_run     boolean NOT NULL DEFAULT false,
  status      text NOT NULL,
  created_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  duration_ms integer,
  error_code  text,
  snapshot    jsonb NOT NULL
);
CREATE INDEX workflow_runs_user_created_idx ON workflow_runs (user_id, created_at DESC);
CREATE INDEX workflow_runs_workflow_created_idx ON workflow_runs (workflow, created_at DESC);
