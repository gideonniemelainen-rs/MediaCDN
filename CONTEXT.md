# mediaCDN domain language

Terms used in code, docs and architecture reviews. Use these names; add to this file when a new concept gets a name.

## Playback

**Quadrant** — one of the four players in the Player page. Each picks its own Delivery and stream. Exactly one is **focused** (has audio); the others are **unfocused**.

**Delivery** — where a quadrant fetches a title from: `direct`, `local`, `s3-near`, `s3-far`, `cdn-public`, `cdn-s3`. A base URL and, for most, an `index.json` listing its titles. Today configured by `VITE_*_BASE` env; becomes a Setting.

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

**Workflow** *(planned)* — a named, typed task the GUI can run on the job runner with live logs: fetch sources, package a title, upload to S3, run the bench. Replaces running the standalone scripts by hand.

**Settings** *(planned)* — config the GUI can edit, stored in Postgres and served by the pipeline API. Groups: deliveries, packaging, player behaviour, origin/ops. Boot-time values (ports, DB URL) stay in env and are shown read-only.

## Measurement

Two unrelated things are both called "benchmark". Keep them apart:

**Benchmark run** — a saved browser telemetry session across quadrants (per-quadrant summaries and events), stored in Postgres and shown on the Analysis page.

**Bench report** — the CLI `tools/bench.mjs` output in `bench/report.json` (segment fetch timings and a cost projection per target), loaded by hand into the Player's benchmark panel.
