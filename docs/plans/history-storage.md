# Postgres store for auth, upload history and benchmark runs

Status: milestones 1 to 3 built (2026-11-23). M1: Postgres in compose, migrations, schema, auth, seeded admin, login gate. M2: job state changes recorded in `uploads` and `upload_stages`, per-user `/jobs` and `/uploads`, Analysis uploads table. M3: "Save run" in the telemetry panel posts the current quadrants' summaries and events to `POST /benchmarks` (one transaction: run, per-quadrant columns, `telemetry-events` blob thinned to 5 MB by dropping periodic samples if needed); `GET /benchmarks`, `/benchmarks/:id`, `/benchmarks/:id/artifacts/:kind` and `DELETE` are per user; the Analysis page lists runs and rebuilds each comparison from its stored blob with the same `summarize` the live panel uses. Server and web tests pass; M3 not yet walked through in a browser. Milestone 4 (charts) not started.

## Context

The app keeps nothing durable. Telemetry lives in the in-memory store (`web/src/telemetry/store.ts`) and is lost on reload unless exported by hand (`toJSON`/`toCSV` in `metrics.ts`). Upload jobs persist only as loose files in `pipeline/work/jobs/<id>.json`. There is no auth. The new Analysis page (`/analysis/`) needs prior uploads and benchmark runs, and charts must be rebuildable on demand.

Decisions (yours):
- **Postgres from the start**, run in Docker Compose for local development. Reason: the app may later run on devices (e.g. a Tizen TV) that cannot keep a database file, and this avoids a SQLite-to-Postgres migration down the line.
- **Local users with cookie sessions**, seeded with `admin` / `admin` for the prototype.

Note on clients: the database is always server-side. A TV or browser only ever speaks HTTP to the API, so no client platform needs a database driver. That is also why the auth below works with a bearer token, not only a cookie.

## Architecture

The **pipeline server becomes the app API** and the only thing that talks to Postgres. It already runs on `127.0.0.1:8790`, is proxied same-origin at `/api/pipeline` (so cookies work without CORS), and has the Host/Origin guards in `pipeline/src/server.mjs`. Routes are added under `/api/pipeline` (rename later if it stops being pipeline-specific).

```
web (cookie or bearer) --/api/pipeline/*--> pipeline/src/server.mjs --> pipeline/src/db/* --pg Pool--> Postgres (compose "db")
```

- Driver: `pg` (node-postgres) with a `Pool`. This is the first runtime dependency in `pipeline/`, so add `pipeline/package.json` and install it in the Dockerfile. No ORM and no query builder: small repo modules with parameterised SQL.
- Config: `DATABASE_URL` (default `postgres://mediacdn:mediacdn@127.0.0.1:5432/mediacdn`, loopback only). Compose publishes the port on `127.0.0.1` only, with a named volume.
- Compose: add a `db` service (`postgres:17`, healthcheck `pg_isready`) to `pipeline/compose.yaml`, with a pinned image tag.
- Startup: `bin/serve.mjs` connects, runs migrations, seeds the admin, then listens. If Postgres is unreachable it exits with a one-line message saying to run `docker compose up -d db`. `/health` also reports DB status so the upload page can show "database not reachable".
- Tests: need a real Postgres. Each test file creates a throwaway schema (`CREATE SCHEMA t_<random>`, `search_path` set on its pool) and drops it afterwards, so tests run in parallel against the compose DB. If `DATABASE_URL` is unreachable the DB tests are **skipped with a clear message**, so `node --test pipeline/` still passes for people without Docker. CI would add a `services: postgres`.

## Schema (migration 001)

Numbered SQL files in `pipeline/src/db/migrations/NNN-name.sql`, applied in order by a ~40-line runner that records them in `schema_migrations(version, applied_at)`, one transaction per migration, guarded by `pg_advisory_lock` so two servers cannot race. Ids are `uuid` (`gen_random_uuid()`, built in since PG13); times are `timestamptz`; JSON is `jsonb`.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `users` | accounts | `id`, `username` unique (citext or lower() index), `password_hash` (scrypt string), `role` (`admin`/`user`), `must_change_password`, `created_at` |
| `sessions` | login sessions | `token_hash` pk (sha256 of the token), `user_id` FK, `created_at`, `expires_at`, `last_seen_at`, `kind` (`cookie`/`bearer`) |
| `uploads` | one row per pipeline job | `id` text pk (= job id), `user_id` FK, `source_name`, `source_bytes` bigint, `source_sha256`, `status`, `output_id`, `created_at`, `ended_at`, `duration_ms`, `error_code`, `snapshot` jsonb (final job snapshot, same shape as `publicJob`) |
| `upload_stages` | per-stage results for querying and charting | `(upload_id, stage)` pk, FK, `status`, `started_at`, `ended_at`, `summary` jsonb |
| `benchmark_runs` | one saved comparison | `id`, `user_id` FK, `label`, `started_at`, `ended_at`, `env` jsonb (user agent, Shaka version, base URLs without secrets, shaping notes), `transport` (nullable, for the later transport plan) |
| `benchmark_sessions` | one row per quadrant in a run | `run_id` FK, `slot`, `stream_id`, `delivery`, plus the `Summary` fields as real columns (`startup_ms`, `rebuffer_count`, `rebuffer_ratio`, `avg_bitrate_kbps`, `mean_segment_latency_ms`, `throughput_kbps`, `errors`) |
| `artifacts` | JSON blobs to rebuild charts on demand | `id`, `owner_kind` (`benchmark_run`/`upload`), `owner_id`, `kind` (e.g. `telemetry-events`, `abr-timeline`), `schema_version`, `json` jsonb, `bytes`, `created_at` |
| `settings` | small per-user key/value | `(user_id, key)` pk, `value` jsonb |

Design rules:
- **Columns for anything you filter, sort or aggregate on; `jsonb` for anything you only render.** The `Summary` fields are columns so the Analysis page can compare runs in SQL (`ORDER BY startup_ms`); raw `TelemetryEvent[]` (`web/src/telemetry/types.ts`) goes in `artifacts` as `kind='telemetry-events'`.
- Blobs carry a `schema_version` so old runs still load after the event shape changes (the transport plan adds fields).
- Blobs live in their own table so list queries never read them (Postgres would TOAST them anyway). Cap about 5 MB per blob: above that, downsample `sample` events and record that in the blob.
- Add a GIN index on a jsonb column only when a real query needs it.
- Indexes: `uploads(user_id, created_at DESC)`, `benchmark_runs(user_id, started_at DESC)`, `benchmark_sessions(run_id)`, `artifacts(owner_kind, owner_id)`.
- `ON DELETE CASCADE` from runs and uploads to their child rows and artifacts.

## Auth

- Hashing with `node:crypto` `scrypt` and `timingSafeEqual` (no dependency).
- Session token: random 32 bytes, stored only as a sha256 hash. Accepted from an `HttpOnly; SameSite=Lax; Path=/` cookie (the local web app, same-origin) **or** an `Authorization: Bearer` header (other clients such as a TV; those need CORS enabled for a configured origin allow-list, off by default). 7-day sliding expiry.
- Routes: `POST /auth/login` (returns the token in the body for bearer clients and sets the cookie), `POST /auth/logout`, `GET /auth/me`, `POST /auth/password`.
- **Seed**: if `users` is empty at startup, create `admin`/`admin` with `must_change_password = true`. The server logs a loud warning on every start while that password is unchanged, and `/auth/me` returns the flag so the UI shows a banner. This is a prototype default, not a security control, acceptable only because the server binds to loopback and Postgres is published on loopback only.
- In-memory login rate limit (per username and IP, about 5 per minute).
- State-changing cookie requests rely on the existing Origin check as CSRF defence. Bearer requests are not CSRF-prone.
- Every write stamps `user_id`; every read filters by it (admins can read all).
- The existing upload endpoints (`POST /uploads`, `GET /jobs…`, SSE) start requiring a session. `EventSource` cannot send headers, so SSE uses the cookie.

## Integration points

1. **Uploads to the DB.** `createJobManager` (`pipeline/src/jobs.mjs`) already persists a snapshot on every change. Add an injected `onChange(job)` hook; the uploads repo upserts the job and stage rows (`INSERT … ON CONFLICT DO UPDATE`, keyed by job id), throttled to state transitions and a coarse progress interval, not every ffmpeg tick. `work/jobs/*.json` stays the live source for SSE and restart recovery; the DB is the history. A DB failure is logged and must **never** fail or stall a pipeline job. Backfill existing `work/jobs/*.json` once, with `user_id` set to the admin.
2. **Benchmarks to the DB.** A "Save run" button in `TelemetryPanel.tsx` posts `{label, env, sessions: Summary[], events}`, built from the existing `summarize` and `sessionEvents` (`metrics.ts`), to `POST /benchmarks`. The server writes run, sessions and artifact in one transaction. A run is saved explicitly, never automatically.
3. **CLI benchmarks.** `tools/bench.mjs` can import later via a bearer token; out of scope now.
4. **Analysis page** (`web/src/AnalysisPage.tsx`): replace the stub with two lists (uploads, benchmark runs) and a detail view that loads the artifact and redraws with the existing `compare.ts` helpers. The chart library is a separate decision; the first cut is tables plus the data endpoints.

## API (all under `/api/pipeline`)

`GET /uploads` (keyset-paged, `?before=`), `GET /uploads/:id`, `GET /benchmarks`, `POST /benchmarks`, `GET /benchmarks/:id`, `GET /benchmarks/:id/artifacts/:kind`, `DELETE /benchmarks/:id`, plus the auth routes. List endpoints never include blobs.

## Code layout

New: `pipeline/package.json`, `pipeline/src/db/{pool,migrate,users,sessions,uploads,benchmarks,artifacts}.mjs`, `pipeline/src/db/migrations/001-init.sql`, `pipeline/src/auth.mjs` (hash, verify, token, cookie helpers, rate limit), `pipeline/src/db/testing.mjs` (per-file schema helper), `web/src/auth/{api,useAuth,LoginPage}.tsx|ts`, `web/src/history/{api,types}.ts`, `docs/plans/history-storage.md`.
Modified: `pipeline/src/server.mjs` (routes, session guard, `/health`), `pipeline/src/jobs.mjs` (`onChange`), `pipeline/bin/serve.mjs` (connect, migrate, seed), `pipeline/compose.yaml` (`db` service), `pipeline/Dockerfile` (install `pg`), `web/src/{main,routes,NavBar,TelemetryPanel,AnalysisPage}.tsx`, `README.md`, `docs/architecture.md`.

## Milestones

1. Postgres in compose, pool, migration runner, schema, users and sessions, auth routes, seeded admin, login page and a session-aware navbar.
2. Uploads history (`onChange` hook, backfill, `GET /uploads`) and the Analysis uploads list.
3. Benchmark save (`Save run`, `POST /benchmarks`, artifacts) and the benchmark list and detail.
4. Charts rebuilt from artifacts on the Analysis page (library chosen then).

## Verification

1. `docker compose up -d db`, then `node --test pipeline/`:
   - Migrations apply from empty and are idempotent; two runners at once do not clash.
   - Repos round-trip rows and jsonb.
   - Scrypt verifies and rejects.
   - Login sets an HttpOnly cookie and returns a bearer token. A wrong password, an expired session and a tripped rate limit are rejected.
   - Routes return 401 without a session and never return another user's rows.
   - The upload `onChange` writes `uploads` and `upload_stages` for the existing e2e fixture run, and a DB outage does not fail the job.
   - Oversize blob handling.
   - With no Postgres reachable, DB tests skip with a message and the rest still pass.
2. `cd web && npm test`: pure helpers (history mappers, route table).
3. Manual: `docker compose up -d db`, `node pipeline/bin/serve.mjs`. Log in as `admin`/`admin` and see the change-password banner. Upload a fixture and find it on Analysis. Use the compare preset, press "Save run", reload, reopen the run, and confirm the blob rebuilds the same numbers. Stop the db container and confirm the server and `/health` report it clearly. `docker compose down -v` then up again recreates and reseeds.

## Risks and notes

- **Local setup cost**: running the app and its tests now needs Docker (or a local Postgres). The skip-without-DB behaviour keeps unit tests usable, but the upload page needs the DB up.
- **Default `admin:admin`**: fine for a loopback prototype; flagged but not enforced. It must be removed or forced to change before any non-local deployment, and Postgres credentials in compose must not be reused anywhere real.
- **Bearer and CORS** are only designed for, not enabled; turning them on needs an explicit origin allow-list and a review of the Host/Origin guards, which are currently loopback-only.
- **Blob growth**: long runs make large event arrays. The cap and downsampling bound it; deletion cascades, and Postgres reclaims space via autovacuum.
- **Backups**: `pg_dump` from the compose container; the named volume survives `docker compose down` but not `down -v`.
- **Migrations are forward-only** for now; there is no down-migration tooling.
- SQLite was the other option considered (zero setup, one file, built into Node). It remains a fallback for a strictly offline single-machine demo, but is not planned.
