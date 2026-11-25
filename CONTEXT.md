# mediaCDN domain language

Terms used in code, docs and architecture reviews. Use these names; add to this file when a new concept gets a name.

## Playback

**Quadrant** — one of the four players in the Player page. Each picks its own Delivery and stream. Exactly one is **focused** (has audio); the others are **unfocused**.

**Delivery** — where a quadrant fetches a title from: `direct`, `local`, `s3-near`, `s3-far`, `cdn-public`, `cdn-s3`. A base URL and, for most, an `index.json` listing its titles. Defined in `shared/src/deliveries.ts`; its base URL and on/off are Settings, with `VITE_*_BASE` env as the default.

**Unfocused cap** — the maximum rendition height (360p, `UNFOCUSED_MAX_HEIGHT` in `shared/src/ladder.ts`) an unfocused quadrant is allowed, so four decodes stay usable. The **uncapped** switch lifts it on every quadrant so quadrants compare at equal quality.

**Transport** — the protocol a segment travelled over (h1, h2, h3), read from resource timing and compared per Delivery.

## Packaging

**Title** — one playable asset: the directory `origin/<id>/` holding HLS and DASH over shared CMAF segments. Uploads become `ugc-<name>` titles.

**Title layout** — the file names inside a Title: `master.m3u8`, `manifest.mpd`, `media_N.m3u8`, `init-N.m4s`, `chunk-N-NNNNN.m4s` (and `live<N>-<seq>.m4s` in simulated live). Defined once in `shared/src/title-layout.ts` (names, URL builders, the title index, the playlist parser), with the name templates handed to both Packagers as `INIT_TEMPLATE`, `CHUNK_TEMPLATE`, `PLAYLIST_TEMPLATE`, `HLS_MASTER` and `DASH_MANIFEST`. Written by the Packagers, read by the origin, index builders, verify stage and web catalog. ffmpeg's DASH muxer always names the HLS playlists `media_<n>.m3u8` itself, so a real-ffmpeg test checks that name against the module.

**Packager** — what writes a Title: `ffmpeg` (`scripts/package.sh`, host) or `shaka` (`pipeline/scripts/package-shaka.sh`, worker image). Both must produce the same Title layout. `node scripts/package-title.mjs <id>` packages a Title by hand.

**Ladder** — the set of Rungs a Title is encoded at. **Rung** — one `{ height, kbps }` rendition. The **fixed ladder** is the `RUNGS` table in `shared/src/ladder.ts`, the only copy; the **content-aware ladder** (Shaka path) is planned from a complexity measurement. Both Packagers receive a ladder from their caller (`RUNGS`, built by `encodeSpec`) and hold no table of their own.

**Mezzanine** — the normalised intermediate (constant frame rate, SDR, stereo) every upload is encoded from.

**Origin** — the local server (`tools/serve-origin.mjs`, :8788) that serves Titles, builds `/index.json` and simulates live HLS.

## Pipeline

**Job / Stage** — an upload's run through the pipeline (probe, validate, normalise, ladder, package, verify, publish). Each Job and Stage is recorded in Postgres and streamed to the Upload page.

**Workflow** — a named, typed task with parameters, defined once in `shared/src/workflows.ts`: probe sources, fetch sources, package a title, make ads, smoke-test the origin, run the benchmark, upload to S3, rebuild the S3 index. The page draws its form and stage graph from that definition and the server validates against it. Replaces running the standalone scripts by hand; the scripts still work by hand.

**Run** — one execution of a Workflow, started with `POST /workflows/:id/runs` (admin only). A Run is a Job: the same stage graph, live log and progress as an upload, kept in `work/runs/<id>.json`, in Postgres (`workflow_runs`) and in `work/runs/<id>/` for what it produced (a benchmark's `report.json`). Uploads and Runs share one queue, so a benchmark is not skewed by an encode.

**Dry run** — the first half of a gated Workflow (`upload-s3`, `rebuild-s3-index`): started without `confirm`, it only looks. A real run must name a successful Dry run of the same Workflow and parameters, by the same user, under 15 minutes old and not used before, or the API answers 409. The rule is in `pipeline/src/runs.mjs`, not in the page.

**Guide** — a Workflow the API never runs (`shape.sh` needs root, `chrome-lab.sh` opens a browser, `lab-certs.sh`); the page shows the exact commands to paste.

**Settings** — config an admin can edit, stored in Postgres and served by the pipeline API (`GET /settings`, public; writes admin-only). The schema is `shared/src/settings.ts`. Boot-time values (ports, DB URL) stay in env, and no Setting holds a secret.

**Group** — a set of Settings written and revisioned together: `deliveries`, `packaging`, `player`, `origin`. One row each in `app_settings`; a write checks the group's revision (`If-Match`).

**Override** — a stored value for one Setting. Only overrides are stored; each client (web, pipeline, origin) lays them over its own defaults, so an empty store changes nothing and a client keeps working on its defaults when the API is down. Deleting an override restores the default.

## Measurement

Two unrelated things are both called "benchmark". Keep them apart:

**Benchmark run** — a saved browser telemetry session across quadrants (per-quadrant summaries and events), stored in Postgres and shown on the Analysis page.

**Bench report** — the CLI `tools/bench.mjs` output in `bench/report.json` (segment fetch timings and a cost projection per target), loaded by hand into the Player's benchmark panel.
