# Upload page with a live transcoding workflow graph

Status: built (2026-11-19) and browser-verified (2026-11-23): upload, the graph updating live through the Vite proxy, a failing upload, a repeat upload reusing the mezzanine, the inline result player and "Open in main app". Since it was written the page has moved behind sign-in (every pipeline route except `/health` needs a session, and jobs are per user; see `history-storage.md`), and the package stage can use Shaka Packager (`PIPELINE_PACKAGER=shaka`; see `transcoding-pipeline.md`). The sections below describe the original design.

Goal: a page at `/upload/` where a user picks a video (first: QuickTime screen recordings). After the upload it runs through the local transcoding pipeline, and the page shows a GitHub-Actions-style workflow graph: one node per step, updating live with status, timing and results.

## Context

- There was no router, no POST endpoint, no SSE and no upload code. `web/src/main.tsx` rendered `<App/>` only and `tools/serve-origin.mjs` rejects everything except GET, HEAD and OPTIONS.
- The pipeline was `pipeline/bin/ingest.mjs`: probe, validate, normalise into `work/<key>/mezzanine.mkv`, as a top-level script with `process.exit` calls. Packaging is `scripts/package.sh`, which hard-wires `media/src/<slug>.mp4`, always `rm -rf`s `origin/<slug>/` and prints nothing machine-readable.
- New titles need no catalog code: `serve-origin.mjs` builds `/index.json` on every request from `origin/*/`, so a packaged `origin/<id>/` appears under Delivery = local after a reload. It gets placeholder metadata ("License not recorded") because the index carries no per-title metadata.
- QuickTime screen recordings are `.mov`, usually Retina-sized, with variable frame rate and often no audio. Milestone-1 normalise handles exactly that (CFR, synthesised silence, even sizes), and `package.sh` alone breaks on it (`-map 0:a:0`).
- The web app is one global dark `index.css` with hard-coded colours and no router, testing-library or CSS tooling.

## Decisions

- The package stage **reuses `package.sh`** (fixed ladder, no per-title tuning). Milestone 2 (Shaka, content-aware ladder) stays separate; see `transcoding-pipeline.md`.
- On completion the page plays the HLS result inline and links into the main app.
- The graph is data-driven: the server owns the stage definitions (`id`, `label`, `needs[]`), so later stages (thumbnails, VMAF) add nodes without UI changes.
- Output ids are `ugc-<slug>`, so uploads cannot overwrite sample titles such as `bbb`.

## Architecture

```
browser /upload/  --XHR POST (raw body)-->  Vite proxy /api/pipeline  -->  pipeline/bin/serve.mjs (127.0.0.1:8790)
        ^                                                                     |
        |-- EventSource job snapshots <---------------------------------------|  runs stages one job at a time
                                                                              v
upload -> probe -> validate -> normalise -> package -> verify -> publish      pipeline/work/ then origin/<id>/
```

## Backend (`pipeline/`)

- `src/stages.mjs`: the stage DAG, `newJob()` and pure state transitions. Stage status is `queued | running | success | failed | skipped | cached`.
- `src/run.mjs`: runs stages in dependency order and emits a full job snapshot on every change. A failed stage marks everything downstream `skipped`.
- `src/ingest.mjs`: per-stage functions extracted from `bin/ingest.mjs`, shared by the CLI and the server. The CLI keeps its contract (first stdout token is the job key, exit codes 0/1/2/3, stderr `rejected: E_...`).
- Normalise uses `spawn` with `-progress pipe:1`, parsed by the pure `parseProgress`.
- `src/steps.mjs`: `package`, `verify` and `publish`.
  - `verifyPackage` is pure: manifests exist, rungs listed in `master.m3u8`, every segment in each media playlist exists, and the title would be listed by `buildIndex`.
  - `publish` atomically renames the staged output (`origin/.tmp-<uploadId>/`) into `origin/<id>/`. The index ignores the staging dir because ids start with `[a-z0-9]`.
- `bin/serve.mjs` on `127.0.0.1:8790`, under `/api/pipeline`: `GET /health`, `POST /uploads` (raw streamed body, `X-Filename`, size cap from the profile), `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/events` (SSE: current snapshot, then every change). Added since: all of these except `/health` need a session cookie, `/jobs` lists only your own jobs (an admin sees all), and `/uploads` serves the history from the database.
  - Snapshots persist to `work/jobs/<id>.json`. Jobs found running at startup are marked failed (`interrupted`). One job runs at a time.
  - It rejects requests whose `Host` is not localhost or whose `Origin` is not the dev server, because any web page could otherwise make it run ffmpeg on arbitrary files.
- `scripts/package.sh`: backward-compatible `INPUT=` and `OUT=` env overrides and `PROGRESS=<file>`. The positional `slug` and `--quick` are unchanged.

## Frontend (`web/src/upload/`)

No new dependencies.

- `main.tsx` renders `UploadPage` for `^/upload/?$`, otherwise `App`. `vite.config.ts` proxies `/api/pipeline` to `127.0.0.1:8790`.
- `UploadPage.tsx`: drop zone and file input, XHR upload for byte progress, recent jobs, and a clear "pipeline server not running" state.
- `WorkflowGraph.tsx`: cards in columns with SVG connectors, status icon, label and duration per node, an animated spinner on the running node (respecting `prefers-reduced-motion`), nodes as labelled buttons, and a live region for job status.
- `graph-layout.ts` (pure): column is the longest path from the roots; handles a linear flow now and fan-out later.
- `StageDetails.tsx` shows the selected node's content.

| Stage | Shows |
| --- | --- |
| upload | name, size, duration, throughput |
| probe | container, resolution, fps (VFR flagged), codecs, audio tracks, rotation, HDR |
| validate | verdict, warnings and errors with their codes |
| normalise | decisions (target fps, audio synthesised, tonemapped), progress, mezzanine size, `cached` if re-ingested |
| package | progress, rungs produced, log tail |
| verify | the check list |
| publish | output path, HLS and DASH URLs |

- `ResultPlayer.tsx`: a small Shaka player for `<VITE_LOCAL_BASE>/<id>/master.m3u8`, plus "Open in main app". The main app reads `?delivery=local&stream=<id>-hls` at startup, and the index is reloaded so the new title is listed.
- `upload.css`: scoped tokens for stage colours, matching the existing dark palette.

## Verification

Done: `node --test pipeline/` (including `server.e2e.test.mjs`, which uploads the generated fixtures to a real server and runs the real stages) and `cd web && npm test`; `tsc -b` and `npm run build` are clean. The manual browser run in item 4 and SSE through the Vite proxy were done on 2026-11-23 (see Status).

1. `node --test pipeline/`: the existing ingest tests pass unchanged (proving the CLI contract survived the refactor), plus new tests for the stage runner, `parseProgress`, `verifyPackage`, id and collision naming, the server API on an ephemeral port, and a server end-to-end run on the generated fixtures.
2. `cd web && npm test`: `graph-layout` and formatting helpers. Vitest here has no DOM environment, so components stay untested, as elsewhere in the repo.
3. `bash -n` and `shellcheck` on `scripts/package.sh`, then package a known title with and without the new env vars and compare.
4. Manual, in three terminals (`node pipeline/bin/serve.mjs`, `node tools/serve-origin.mjs`, `cd web && npm run dev`): upload a QuickTime `.mov`, watch the graph, play the result, find it in the main app under Delivery = local; upload an audio-only file (validate red, later nodes skipped); upload the same file twice (normalise `cached`).

## Risks

- **Disk.** Source, mezzanine and packaged output all persist. The mezzanine was 384 MB for 10 minutes of 720p at CRF 12, and Retina recordings will be larger. Show sizes in the graph, defer cleanup, revisit the mezzanine CRF.
- **Encode time.** Five x264 `veryfast` rungs from a large mezzanine. Progress makes it visible.
- **Security.** A local server running ffmpeg on uploaded files: loopback binding plus the Host/Origin checks now, the Docker image later.
- **Metadata.** Uploaded titles show as their id with "License not recorded". A sidecar and index change is a follow-up.
- **Fixed ladder.** Screen recordings get film bitrates until milestone 2.
- **Dev only.** Needs the local job server; not a deployable upload service.
- **SSE through the Vite proxy**: confirmed working (2026-11-23).
