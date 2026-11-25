# Architecture

## Target

Browser (React SPA) -> 4x Shaka players -> Media CDN (EdgeCacheService) -> EdgeCacheOrigin(s) -> external public test streams.
Ads: client calls `GET /api/ad` (Cloud Run) and plays the returned clip, served via the `/ads/*` Media CDN route, in a non-focused quadrant.

Decisions: React + Vite + TS, Shaka Player (HLS + DASH), external origins, own ad clips + simple ad API, Terraform.

Status: the Media CDN, Terraform (`infra/` is empty) and the ad service (`ad-service/` is empty) are not built. What exists today is the player, a local origin, S3 buckets as origins, the upload pipeline and a database for history. The local stack below is what runs.

## Local stack

`bash scripts/dev.sh` starts everything (`PIPELINE_PACKAGER=shaka` switches packaging to Shaka Packager).

| Service | Port | Role |
| --- | --- | --- |
| Postgres (`pipeline/compose.yaml`, container `db`) | 5432, loopback | accounts, sessions, upload history, saved benchmark runs |
| Origin (`tools/serve-origin.mjs`) | 8788 | serves `origin/<id>/` (HLS, DASH, ranges, CORS), builds `/index.json`, simulates live HLS at `/live/<id>/` |
| Pipeline API (`pipeline/bin/serve.mjs`) | 8790, loopback | sign-in, uploads and the transcoding job graph, upload history, benchmark runs. Reached through Vite's `/api/pipeline` proxy, so cookies are same-origin |
| Web (`web/`, Vite) | 5173 | the app |

```
browser --/api/pipeline--> pipeline API --> Postgres
   |                           |--> ffmpeg / Shaka Packager --> origin/<id>/ <--- origin server :8788
   '--- 4 players, one delivery each ---> origin :8788 | S3 near | S3 far | Media CDN | direct URLs
```

## Pages

- **Player** (`/`): four quadrants, focus-based audio, and a telemetry panel. Open without signing in.
- **Upload** (`/upload/`): sign-in required. A GitHub-Actions-style graph of the pipeline stages for each upload.
- **Analysis** (`/analysis/`): sign-in required. Upload history and saved benchmark runs. Opening a run rebuilds its comparison table and three time-series charts (bitrate, buffer, segment time) from the stored telemetry.

There is no router; pages are pathnames (`web/src/routes.ts`) and the navbar links reload the page.

## Deliveries

Each quadrant picks its own delivery, so one title can be compared across sources live. A delivery is a base URL and, for most, an `index.json` listing its titles.

| Delivery | Source | Variable |
| --- | --- | --- |
| `direct` | public third-party URLs | none |
| `local` | the origin on this machine | `VITE_LOCAL_BASE` |
| `s3-near`, `s3-far` | two S3 buckets, no CDN | `VITE_S3_NEAR_BASE` (or `VITE_S3_BASE`), `VITE_S3_FAR_BASE` |
| `cdn-public`, `cdn-s3` | Media CDN in front of a public origin or S3 | `VITE_CDN_BASE` |

The variables are defaults. **Settings** (groups `deliveries`, `packaging`, `player`, `origin`; schema in `shared/src/settings.ts`) are stored as sparse overrides in the `app_settings` table, one row per group, and served publicly by `GET /api/pipeline/settings`; only an admin can `PUT /settings/<group>` or `DELETE /settings/<group>/<field>`, with an `If-Match` revision check per group. Each client merges the overrides over its own defaults and keeps working on them if the API is unreachable: the web app refetches on tab focus (`web/src/settings/store.ts`), the pipeline reads the packaging group for each job (`createSteps`), and the origin reads the origin group with a 5 s cache (`tools/origin-settings.mjs`). Settings never hold secrets, and boot-time values (ports, `DATABASE_URL`) stay in env.

The telemetry table marks the best value per metric when quadrants play the same stream. Unfocused quadrants are capped at 360p, so bitrate compares unfairly between a focused and an unfocused quadrant. A saved run records each quadrant's cap, and its charts say when the caps differed. Both the live table and a reopened run leave the average bitrate unmarked, with a note, when quadrants playing the same stream had different caps. The "uncapped" switch in the header lifts the cap on every quadrant, and the "compare" presets turn it on, so those comparisons are at equal quality. Segment times still depend on the rung chosen, so they are marked either way.

## Ingest

Uploads go through `pipeline/`: probe, validate, normalise (to a constant-frame-rate, SDR, stereo mezzanine), ladder (a CRF probe picks per-title rungs and rates, so screen recordings cost a fraction of film; Shaka path only), package, verify, publish into `origin/ugc-<name>/`. Two packagers write the same layout: `scripts/package.sh` (ffmpeg, the default) and `pipeline/scripts/package-shaka.sh` in the worker image (Shaka Packager, CMAF). Both take their ladder from `shared/src/ladder.ts` through `RUNGS`, and the file names of a Title from `shared/src/title-layout.ts`, and hold neither a table nor a layout name of their own; `node scripts/package-title.mjs <id>` packages a title by hand. Each job and stage is recorded in the database. See `plans/transcoding-pipeline.md` and `plans/upload-page.md`.

## Workflows

The standalone scripts are Workflows (`shared/src/workflows.ts` holds each one's parameters and stages; `pipeline/src/workflows/` holds what it does). A Run is a Job on the same runner as an upload, so it has the same stage graph, live log and history, and both take turns on one queue (`pipeline/src/queue.mjs`). Most Workflows run the existing script as a child process, with arguments passed as data and an environment of `PATH` plus what the Workflow hands it (`workflows/spawn.mjs`); the benchmark is a function call (`tools/bench-run.mjs`) whose report is saved with the Run, never over `bench/report.json`. Package-a-title packages beside the Title and swaps it in only once it verifies. The two S3 Workflows are gated: a real run needs the id of a successful Dry run (`checkConfirm` in `runs.mjs`), and the AWS CLI gets the bucket and the host's profile location, never keys or server secrets. API: `GET /workflows`, `POST /workflows/:id/runs`, `GET /runs`, `/runs/:id`, `/runs/:id/events`, `/runs/:id/files/<name>.json`, all admin only. The Workflows page comes next; see `plans/workflows.md`.

## Accounts and history

Local users with cookie or bearer sessions; a seeded `admin` / `admin` account, flagged with a banner until its password is changed (not enforced; a prototype default, safe only because everything binds to loopback). Everyone sees their own uploads and runs; an admin sees all. See `plans/history-storage.md`.

## Plans

`docs/plans/` holds the plans, each with a status line. `plans/audit-2026-11-23.md` is the most recent check of all of them against the code.
