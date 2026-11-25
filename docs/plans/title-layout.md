# Step 2: one module owns the Title layout

Status: planned 2026-11-25, not started. Second of six steps toward a GUI-driven tool; step 1 is `shared-ladder.md` (done, on `refactor/shared-ladder`). Terms are in `CONTEXT.md`.

## Why

What a Title is (`master.m3u8`, `manifest.mpd`, `media_N.m3u8`, `init-N.m4s`, `chunk-N-NNNNN.m4s`, and `live<N>-<seq>.m4s` in simulated live) is a contract between two writers and about ten readers, and no module owns it. Each re-types the names.

| Role | Where the names are typed today |
| --- | --- |
| Writers | `scripts/package.sh` (ffmpeg's `-init_seg_name`, `-media_seg_name`), `pipeline/scripts/package-shaka.sh` (`init_segment=`, `segment_template=`, `playlist_name=`, the master and MPD outputs), `pipeline/spike/shaka-spike.sh` |
| Readers, Node | `tools/serve-origin.mjs` (`^media_(\d+)\.m3u8$`, `^live(\d+)-\d+\.m4s$`, `/live/<slug>/<file>`), `tools/live.mjs` (`parseMediaPlaylist`, the `live<N>-<seq>` names), `tools/index-lib.mjs` (`master.m3u8`, `manifest.mpd`, the slug regex), `tools/s3-index.mjs`, `tools/bench.mjs:57-58`, `tools/smoke-origin.mjs`, `scripts/make-ads.mjs:94,103`, `pipeline/src/package.mjs`, `pipeline/src/steps.mjs:206-210,229` |
| Readers, web | `web/src/catalog.ts` (`SAFE_ID`, `parseIndex`, the `master.m3u8` / `manifest.mpd` / `/live/<id>/` locations), `web/src/launch.ts` (`STREAM_ID`, the same regex a third time) |

Two things make it worse than plain duplication:
- **The index document has a writer and a reader that don't know each other.** `buildIndex` (`tools/index-lib.mjs`) writes `index.json`; `parseIndex` (`web/src/catalog.ts`) re-implements the reading side, with its own slug regex and protocol list. The pipeline also reaches into `tools/` for both `buildIndex` and `parseMediaPlaylist`.
- **Only the Shaka path is checked.** `verifyPackage` and `shaka.e2e.test.mjs` catch layout drift on the Shaka path; nothing ties the ffmpeg script's names to the readers except `server.e2e.test.mjs` happening to pass.

The seams are real: two Packagers write the layout and two index builders read it (the local origin and S3), so this is a deepening with more than one adapter on each side.

## Decisions already made

- The title layout lives in `shared/` in TypeScript, no build step (step 1's decision).
- Bash packagers stay as thin executors and receive name templates from the Node caller, as they now receive rungs.
- One commit per step; tests green at each work item.

## Target shape

```
shared/src/title-layout.ts
  names      HLS_MASTER, DASH_MANIFEST, mediaPlaylist(rep), initSegment(rep), chunk(rep, n),
             liveSegment(rep, seq) and the matching parsers (isMediaPlaylist, parseLiveSegment, ...)
  templates  TEMPLATES = { init, chunk, playlist } with a $Rep$ placeholder, handed to the scripts
  ids, urls  isSafeId, titleLocation(prefix, id, 'hls'|'dash'), liveLocation(id), indexLocation(base, prefix),
             parseLivePath(rel)
  playlist   parseMediaPlaylist (moved from tools/live.mjs)
  index      TitleIndex, IndexTitle types, buildIndex (moved), parseIndex (moved from catalog.ts)
shared/src/title-layout.test.ts
```

The module is wide on names but each is trivial; the behaviour that earns the depth is `buildIndex`, `parseIndex` and `parseMediaPlaylist`, which now live next to the names they depend on. Callers stop typing names and regexes at all.

## Work, in order

1. **Create `shared/src/title-layout.ts` with the names, ids and URL builders, plus its test.** Pure, no `node:` imports, so the web app can import it. Gate: `node --test shared/`.
2. **Move the index document and the playlist parser in.** `buildIndex` from `tools/index-lib.mjs` and `parseMediaPlaylist` from `tools/live.mjs` move in; `parseIndex` and the index types move from `web/src/catalog.ts`. Delete `tools/index-lib.mjs`. Move their tests: the three in `tools/index-lib.test.mjs`, the `parses init, durations and URIs` test from `tools/live.test.mjs`, and the `parseIndex` tests in `web/src/catalog.test.ts` (the web test stays for `streamsFromIndexes`). Add a round-trip test: `parseIndex(buildIndex(listing))` returns the same titles, which no test checks today. Gate: `node --test shared/ tools/ pipeline/`, `cd web && npx tsc -b && npx vitest run`.
3. **Repoint the Node readers.** `tools/serve-origin.mjs` (route matching through `parseLivePath` and the live-segment parsers), `tools/live.mjs` (live names), `tools/s3-index.mjs`, `tools/bench.mjs`, `tools/smoke-origin.mjs`, `scripts/make-ads.mjs`, `pipeline/src/package.mjs`, `pipeline/src/steps.mjs`, `pipeline/src/server.e2e.test.mjs`, `pipeline/src/shaka.e2e.test.mjs`. The pipeline no longer imports from `tools/`. Gate: all node suites, plus `node tools/smoke-origin.mjs <id>` against a running origin (needs `node tools/serve-origin.mjs`).
4. **Repoint the web readers.** `catalog.ts` builds locations through `titleLocation` / `liveLocation` / `indexLocation`; `launch.ts` uses `isSafeId`. Gate: `tsc -b`, `vitest run`, `vite build`, and the Player page loads with the local delivery.
5. **Hand the templates to the writers.** `packageCommand` passes `INIT_TEMPLATE`, `CHUNK_TEMPLATE` and (Shaka only) `PLAYLIST_TEMPLATE`, built from `TEMPLATES`; each script replaces `$Rep$` with what its tool uses (`$RepresentationID$` for ffmpeg, the loop index for Shaka) and passes the master name the same way (`-hls_master_name` for ffmpeg, `--hls_master_playlist_output` for Shaka); only the ffmpeg media playlist names cannot be passed (see Risks). `pipeline/spike/shaka-spike.sh` is a spike and is left alone, with its comment pointing at the layout module. Extend `packager-scripts.test.mjs` (its `PRINT_ARGS=1` mode) to assert each script uses the templates it is handed, with names neither could produce itself, as step 1 did for rungs.
6. **Check the names the tools fix themselves.** Add to `scripts/package-title.test.mjs` (real ffmpeg) a check that every file the ffmpeg packager wrote is recognised by the layout module (master, manifest, `media_N`, `init-N`, `chunk-N-NNNNN`) and nothing else was written. This is the contract test the ffmpeg path lacks.
7. **Docs.** `CONTEXT.md` (Title layout now points at the module), `docs/architecture.md`, `docs/plans/transcoding-pipeline.md` line 57 ("Output layout stays compatible…"), `docs/benchmark.md` if it names the layout, and the comment in `pipeline/spike/shaka-spike.sh`.

## Verification

- `node --test shared/ scripts/ pipeline/ tools/` (the Shaka e2e needs Docker and the worker image and is skipped without them).
- `cd web && npx tsc -b && npx vitest run && npm run build`.
- Manual: `bash scripts/dev.sh`, load the Player with the local delivery, play an HLS and a DASH title and the simulated live one; upload a clip through the Upload page and confirm it appears in the picker.

## Risks and open questions

- **ffmpeg fixes one name itself.** Checked against the installed ffmpeg (`ffmpeg -h muxer=dash`): `-init_seg_name`, `-media_seg_name` and `-hls_master_name` can be passed, but the HLS media playlists are always `media_%d.m3u8`, with no option to rename them. So `package.sh` takes the init, chunk and master names from the layout module, while `media_N.m3u8` stays the muxer's choice: the layout module still owns the name, the readers use it, and work item 6's contract test is what guards the ffmpeg script against a muxer change.
- **Shaka's template syntax differs from ffmpeg's.** Both use `$Number%05d$`, but ffmpeg's representation placeholder is `$RepresentationID$` and Shaka's is whatever the script substitutes. The `$Rep$` placeholder is a convention of ours; if it complicates the scripts more than it saves, fall back to passing only the tested names and rely on the contract tests.
- **Live names.** `live<N>-<seq>.m4s` is produced by `buildLivePlaylist` and read back by `liveSegmentFile` and `serve-origin`; today the prefix is built by string concatenation in three places. Moving the format into the layout module changes `buildLivePlaylist`'s `prefix` argument; keep its output byte-identical and cover it with the existing live tests.
- **Where Titles live in a bucket.** `media/<slug>/` in `scripts/upload-s3.sh`, `tools/s3-index.mjs`, and the `/pub` and `/s3` CDN prefixes in `catalog.ts` describe a Delivery, not the layout inside a Title. They belong to step 3 (Delivery module) and step 4 (workflows) and are out of scope here.
- **Open questions for you:** (a) delete `tools/index-lib.mjs` outright (planned) or leave a re-export for one commit? Nothing outside the repo imports it. (b) Rename `tools/live.mjs`'s exports at the same time, or keep names and only move the parser? The plan keeps the names.

## Where this goes

Step 3 is the settings schema, API, Postgres table and a runtime Delivery module, which consumes `indexLocation` and `titleLocation` from this module. Step 4's workflow registry gets "package a title", "upload to S3" and "rebuild the S3 index" as workflows over these same names.
