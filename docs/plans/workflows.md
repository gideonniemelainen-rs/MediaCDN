# Step 4: Workflows, a registry on the job runner

Status: planned 2026-11-25, decisions settled (listed at the end), nothing built. Fourth of six steps toward a GUI-driven tool; steps 1-3 are `shared-ladder.md`, `title-layout.md` and `settings-and-deliveries.md` (built). Terms are in `CONTEXT.md`. Step 5 builds the Workflows page on what this step serves.

## Why

Today the runbook is a list of commands typed in the right order (README "Local workflow"). Each one is a standalone script with its own argument style, and nothing records that it ran or what it said:

| Task | Entry point today | Shape |
| --- | --- | --- |
| Check the public sources | `scripts/probe-sources.mjs [origin]` | node, reads `media/sources.json` |
| Fetch sources | `scripts/fetch-sources.mjs [id ...]` | node, writes `media/src/` |
| Package a title | `scripts/package-title.mjs <id> [--quick]` | node, spawns ffmpeg through `package.sh` |
| Make the ad clips | `scripts/make-ads.mjs [id ...]` | node, ffmpeg, then package |
| Smoke-test the origin | `tools/smoke-origin.mjs [slug]` | node, starts its own server |
| Upload a title to S3 | `scripts/upload-s3.sh <slug> [--go]` (needs `S3_BUCKET`) | bash, dry run unless `--go`; rebuilds the index at the end |
| Rebuild the S3 index | `tools/s3-index.mjs [--go]` (needs `S3_BUCKET`) | node, dry run unless `--go` |
| Run the delivery benchmark | `tools/bench.mjs --target name=url ...` | node, one top-level script that parses `argv`, runs and writes `bench/report.json` |
| Shape the network | `sudo bash tools/shape.sh on ...` | needs root |
| Launch the transport-lab Chrome | `bash tools/chrome-lab.sh` | opens a browser |
| Make lab certificates | `bash tools/lab-certs.sh` | mkcert |

The upload pipeline already has what the GUI needs for these: a stage graph, a runner that emits a snapshot after every change, live logs and progress over SSE, and history in Postgres. It is wired to uploads only (`STAGES` is fixed, `create()` takes an uploaded file).

## Decisions already made (from the design interview)

- Scope is config plus workflows. The GUI does not supervise processes (`dev.sh` does).
- Workflows are a registry on the existing job runner (`runJob`, `stages.mjs`).
- `shape.sh` (sudo) and `chrome-lab.sh` (opens a browser) are **guided cards**: the page shows the exact command to copy and what it does, and the API never runs them. `lab-certs.sh` is the same kind of thing (a one-off, touches a keychain-adjacent tool).
- `upload-s3` always dry-runs first, then needs an explicit confirm. AWS credentials come from the host profile and are never stored.
- Bash stays thin: Node builds the arguments and environment.
- Admin only (step 3's rule for writes carries over: running a task on the host is at least that sensitive).

## Target shape

```
shared/src/workflows.ts          the registry's DATA, importable by the web page too:
                                   id, label, summary, kind: 'run' | 'guide',
                                   params (typed like settings fields: text, int, bool, enum, slug, url),
                                   stages (id, label, needs) for the graph the page draws,
                                   safety: 'safe' | 'dry-run-then-confirm'
pipeline/src/workflows/index.mjs the registry's BEHAVIOUR: id -> { build(params) -> argv/env | fn, parse(output) }
pipeline/src/workflows/*.mjs     one small file per workflow: validates params, returns what to run
pipeline/src/runs.mjs            run manager: createJobManager generalised (see below)
GET  /workflows                  the catalog (from shared/, plus which are runnable here)
POST /workflows/:id/runs         start a run (admin); body = params
GET  /runs, /runs/:id, /runs/:id/events   list, snapshot, SSE (same shape as /jobs)
```

- **The registry's data lives in `shared/`** so the Workflows page renders parameter forms and graphs from the same definition the server validates against (the way `settings.ts` does). The server never trusts the page: it validates `params` with the same module.
- **A run is a job**: the same snapshot, the same stage statuses, the same log and progress helpers, so the Workflows page can reuse the Upload page's job-graph components. `newJob` already takes `stages`.
- **Most workflows run the existing script as a child process** with arguments built in Node (the registry never shells out through a string: `spawn(cmd, argv)`, parameters validated first, slugs by `isSafeId`). The scripts stay runnable by hand. stdout lines become the stage log; a non-zero exit fails the stage with the stderr tail, as the package stage does now.
- **The bench is extracted into a function** (`tools/bench-run.mjs`: `runBench({ targets, slug, rounds, segments, rates }, { log, progress }) -> report`), and `tools/bench.mjs` becomes a thin CLI over it. The registry calls the function, so progress is real (round N of M) instead of scraped from output.
- **Run history** goes in Postgres beside upload history (a `workflow_runs` table: id, workflow, params, status, timestamps, user, the final job snapshot), so a run is still there after a restart.

## Workflows in the first cut

| Workflow | Params | Stages | Safety |
| --- | --- | --- | --- |
| Probe sources | origin (url, optional) | probe | safe |
| Fetch sources | ids (optional list) | fetch | safe (writes `media/src/`, skips existing) |
| Package a title | id (slug), quick (bool) | probe height, package, verify | safe (rewrites `origin/<id>/`) |
| Make ads | ids (optional) | encode, package | safe |
| Smoke-test the origin | slug | smoke | safe |
| Run the benchmark | targets, slug, rounds, segments | run, write report | safe |
| Upload a title to S3 | slug, bucket | dry run, **confirm**, upload, rebuild index | dry-run-then-confirm |
| Rebuild the S3 index | bucket | dry run, **confirm**, upload | dry-run-then-confirm |
| Guides | (none) | copy-paste cards: shape the network, lab certificates, Chrome lab | never run by the API |

## The confirm gate

The runner has no pause: a run goes through its graph to the end. The gate is therefore not a paused stage but a rule on starting the second run:

1. `POST /workflows/upload-s3/runs` with `{ slug, bucket }` always runs the **dry run** only (its stages: dry run, and nothing after). It records the params and the dry run's output.
2. The page shows the dry run's listing (what would be uploaded, sizes) and a **Confirm** button.
3. `POST /workflows/upload-s3/runs` with `{ slug, bucket, confirm: <dry run id> }` runs the real upload **only if** that dry run exists, succeeded, was started by the same user, has identical params and is under 15 minutes old. Anything else is a 409 that says why.
4. A confirm is single use.

This keeps the safety in the API, not in the page: calling the endpoint with `go` and no dry run does nothing. The AWS profile is the host's (`AWS_PROFILE`, default `mediacdn-uploader`), which has no DeleteObject, so the worst case of a bad confirm is an upload of the wrong title.

## Work, in order

1. **Registry data and param validation in `shared/`**: `workflows.ts` with the table above, `validateParams` (reusing the settings field types), and tests including hostile slugs and unknown params. Gate: `node --test shared/`.
2. **Extract the bench**: `tools/bench-run.mjs` and a thin `tools/bench.mjs`; move the logic and keep `bench-lib.test.mjs` green; add a test that runs `runBench` against a local stub server. Gate: `node --test tools/`, and `node tools/bench.mjs --target local=http://localhost:8788` gives the same report shape.
3. **Run manager**: generalise `createJobManager` (or add `createRunManager` over the same pure parts), with `workflow_runs` in a migration `003`, history in `db/runs.mjs`, restart handling as for uploads. Decide the queue (below). Gate: unit tests with stub workflows, a DB test, as `jobs` has today.
4. **Process workflows**: a `spawnStage` helper (argv, env, log lines, progress, exit code to `StageError`), then the safe workflows one by one, each with a test that uses a stand-in script, plus one real run (package a title) in the e2e style.
5. **Confirm gate and the S3 workflows**: the dry-run/confirm rules above, tested with a fake `aws` on `PATH` (no AWS in tests), including every rejection (no dry run, other user, other params, stale, reused).
6. **API**: `GET /workflows`, runs list, run snapshot and SSE, `POST` (admin only; 401, 403, 400 with field errors, 409 for the gate), with real-HTTP tests like `server.settings.test.mjs`.
7. **Docs**: `CONTEXT.md` (Workflow, Run, Guide, Dry run), README runbook shrinks to `dev.sh` plus "the rest is in the Workflows page", `docs/architecture.md`.

The page itself is step 5; until then the API is exercised by tests and `curl`.

## Verification

- `node --test shared/ scripts/ pipeline/ tools/`, `cd web && npx tsc -b` (the registry is imported by `web/` in step 5, so keep it type-clean now).
- Manual: start a "package a title" run through the API and watch `/runs/:id/events`; run the S3 dry run against a real bucket with the mediacdn-uploader profile and confirm that the real upload is refused without one.

## Risks

- **Heavy work in the API process.** ffmpeg and bench runs are CPU and bandwidth heavy and a bench run measures the network, so a concurrent upload skews it. The queue is shared with uploads (decision 2).
- **A workflow that reads `process.env`.** `S3_BUCKET` and `AWS_PROFILE` are read by the scripts from the environment; the registry passes them explicitly in the child's `env` and passes nothing else from the server's environment but `PATH`, so a run is reproducible and cannot read the server's `DATABASE_URL`.
- **`bench/report.json` is tracked.** A bench run through the API must not dirty the working tree. Decision 3: reports are per run.
- **Cancel.** Stopping a run means killing its child process group; first cut has no cancel button, and a restart marks running runs failed as for uploads.
- **Scripts that open things** (`chrome-lab.sh`, `shape.sh`) are guides precisely because they cannot work headless or without root.

## Decisions (2026-11-25)

1. **Confirm gate:** a dry-run id is required, as described above. The gate is in the API.
2. **Queue:** one shared queue with uploads, so a bench run is not skewed by a concurrent encode.
3. **Bench report:** stored per run (`workflow_runs` and `pipeline/work/runs/<id>/`); `bench/report.json` stays the CLI's output and a GUI run never writes it.
4. **S3 bucket:** a run parameter that defaults to the server's `S3_BUCKET`; not a Setting.
