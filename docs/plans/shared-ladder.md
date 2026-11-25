# Step 1: `shared/` in TypeScript, with the ladder as the proving slice

Status: planned 2026-11-25. Work item 1 done 2026-11-25 (ladder and its test moved to `shared/`, `node --test shared/ pipeline/ tools/` 185 pass, 1 skipped, as before; `shared/` type-checks under `--strict --erasableSyntaxOnly`); item 2 done 2026-11-25 (`@shared` alias in `web/vite.config.ts` and `tsconfig.app.json`, `fs.allow: ['..']`, `UNFOCUSED_MAX_HEIGHT` now defined in `shared/src/ladder.ts` and imported by `QuadrantPlayer.tsx`; `tsc -b`, `vitest run` 150 pass and `vite build` all pass; dev server confirmed serving `shared/` by the user); item 3 done 2026-11-25 (`encodeSpec` and `VBV` in `shared/src/ladder.ts`; `package.sh` and `package-shaka.sh` take `RUNGS` as `height:kbps:maxrate:bufsize` and hold no table or bitrate arithmetic; `packageCommand` passes it to both packagers; `node --test shared/ pipeline/ tools/` 187 pass, 1 skipped; real `package.sh` run on a generated clip gives the same layout; `package-shaka.sh` only syntax-checked, since the Shaka e2e needs Docker and the image). Item 4 done 2026-11-25 (`parseRungsLine` and its test deleted, and the unused `ctx.shared.rungs` write; the package stage reports the ladder it passed; the log line was read only there, the web app reads `result.rungs`; 186 pass, 1 skipped; `server.e2e.test.mjs` packages real uploads with ffmpeg through the new path). Item 5 done 2026-11-25 (`scripts/package-title.mjs <slug> [--quick]` with `scripts/package-title.test.mjs`, 2 pass including real packaging of the full and quick ladders; `scripts/make-ads.mjs` called `package.sh` directly and now goes through it, and `node scripts/make-ads.mjs bumper-6` regenerated an ad correctly; README runbook updated). Item 6 done 2026-11-25 (`PRINT_ARGS=1` on both scripts; `pipeline/src/packager-scripts.test.mjs`, 7 tests, hands each script rung values neither could compute itself and checks heights, rates, peaks and buffers; a mutation putting `b*3/2` back into either script fails 3 of them; this was the first real run of `package-shaka.sh`'s new parsing; the fake sync test is gone and the table snapshot moved to `shared/src/ladder.test.ts`; 195 pass, 1 skipped). Item 7 done 2026-11-25 (README Layout and commands, `docs/architecture.md`, `pipeline/README.md`, `transcoding-pipeline.md`, `upload-page.md`, `CONTEXT.md`, and a comment in `steps.mjs`; the dated audit is left as a record). **Step 1 complete.** Not run: the Shaka e2e (needs Docker and the worker image). First of six steps toward a GUI-driven tool (see "Where this goes"). Not committed.

## Why

The ladder is defined in two places that disagree about who is in charge:

- `pipeline/src/ladder.mjs` holds `RUNGS`, `selectRungs` and `planLadder`.
- `scripts/package.sh:25-35` holds its own table (`240:400 … 1080:5000`), its own `--quick` set, its own `$src_h:800` fallback and its own VBV arithmetic (`b*3/2`, `b*2`). `pipeline/scripts/package-shaka.sh` repeats the VBV arithmetic.
- `packageCommand` (`packagers.mjs:30-32`) computes rungs for the ffmpeg packager and then passes only the output id. `package.mjs:8-17` learns which rungs were used by scraping a log line.
- The test "the ladder matches … `scripts/package.sh`" (`packagers.test.mjs:24-26`) compares `RUNGS` to a literal and never reads the script, so it cannot fail when they drift.
- The 360p unfocused cap is `LOW_RUNG_HEIGHT` (`ladder.mjs:15`) and `UNFOCUSED_MAX_HEIGHT` (`QuadrantPlayer.tsx:24`), tied only by a comment.

## Decisions already made (from the design interview)

- `shared/` is TypeScript with **no build step**: Node 26 runs `.ts` natively, and `web/tsconfig.app.json` already has `erasableSyntaxOnly` and `allowImportingTsExtensions`. So shared code uses erasable syntax only (no enums, namespaces or parameter properties) and imports with explicit `.ts` paths.
- Bash packagers stay, as thin executors that **own no tables**: the Node caller passes rungs and rate settings in.
- Each step is its own commit, tests green at each step.

## Target shape

```
shared/
  package.json            { "type": "module", "private": true }
  src/ladder.ts           RUNGS, UNFOCUSED_MAX_HEIGHT, selectRungs, planLadder, LADDER_CRF,
                          VBV (maxrate 1.5x, bufsize 2x), SEGMENT_SECONDS, formatRungs
  src/ladder.test.ts      moved from pipeline/src/ladder.test.mjs
```

The ladder module's interface, as callers see it:

- `selectRungs(sourceHeight, { quick })` and `planLadder(measured, { aspect, fps })`, unchanged in behaviour.
- `encodeSpec(rungs)` → the rung list in the exact form the scripts take, **including** each rung's VBV `maxrate` and `bufsize`, so no script computes bitrates.
- `UNFOCUSED_MAX_HEIGHT`, with `LOW_RUNG_HEIGHT` derived from it, imported by both `planLadder` and `QuadrantPlayer.tsx`.

## Work, in order

1. **Create `shared/` and move the ladder.** `git mv pipeline/src/ladder.mjs shared/src/ladder.ts` (add types), move `ladder.test.mjs` to `ladder.test.ts`. Re-point imports in `pipeline/src/{steps,packagers,complexity,…}.mjs` to `../../shared/src/ladder.ts`. Gate: `node --test shared/ pipeline/` passes with no behaviour change.
2. **Web consumes `shared/`.** Add a `@shared` alias in `web/vite.config.ts` (also needed for vitest) and `server.fs.allow: ['..']` so Vite can serve files outside `web/`; add the path to `tsconfig.app.json`. Replace the local `UNFOCUSED_MAX_HEIGHT` in `QuadrantPlayer.tsx`. Gate: `cd web && npx tsc -b && npx vitest run` and `npm run build`.
3. **Pass the ladder into `package.sh`.** `package.sh` takes `RUNGS` (and `SRC_H`) from the environment like `package-shaka.sh` does, and loses the table, `--quick`, the fallback and the `ffprobe` height read. Both scripts take the VBV values as part of the rung spec instead of computing `b*3/2` and `b*2`. `packageCommand` passes `RUNGS` for both kinds, so its `ffmpeg` branch stops ignoring `rungs`.
4. **Delete the log scrape.** `parseRungsLine` and its test go; the package stage already knows the rungs it passed. (Confirm nothing else reads the `-> rungs:` line, for example the Upload page.)
5. **Keep the standalone CLI working.** `scripts/package.sh <slug> [--quick]` is in the README runbook and used by hand, but would now need `RUNGS`. Add `scripts/package-title.mjs <slug> [--quick]`: probe height, `selectRungs`, spawn `package.sh`. Update README. This is also the seed of the "package a title" Workflow in step 4.
6. **Replace the fake sync test.** Give both scripts a `PRINT_ARGS=1` mode that prints the filter graph and per-rung args and exits before ffmpeg. A new test runs each script that way with the same `RUNGS` and asserts the heights, bitrates, maxrate and bufsize match `encodeSpec`. This runs without ffmpeg or Docker, and fails if either script reintroduces its own numbers.
7. **Docs.** `docs/architecture.md` Ingest paragraph, README Layout and commands, and `transcoding-pipeline.md` ("`scripts/package.sh` has its own table") updated. `pipeline/README.md` if it mentions the table.

## Verification

- `node --test shared/ pipeline/ tools/` (the ingest integration test needs ffmpeg; the Shaka e2e needs Docker and is skipped without it).
- `cd web && npx tsc -b && npx vitest run && npm run build`.
- Manual: `node scripts/package-title.mjs <id> --quick` produces the same file list as before for a fixture; upload one file through the Upload page and confirm the package stage reports the ladder the ffmpeg path actually used.

## Risks and open questions

- **Vite serving outside `web/`.** `fs.allow` plus the alias should do it; if the production build or vitest trips on `.ts` imports from outside the root, fall back to a symlink-free copy step, which would break the "no build step" decision. Check in work item 2 before going further.
- **`.ts` imports from `.mjs` under `node --test`.** Works on Node 26 (type stripping is on by default). If the project's minimum Node is lower, record it in `engines` and in the README. Node version is not currently pinned anywhere in `package.json`.
- **Rung spec format change.** Adding `maxrate` and `bufsize` to each rung token changes the `RUNGS` env both scripts parse. The Shaka script runs inside the worker image with the scripts directory mounted read-only (`packageCommand` mounts `/scripts`), so no image rebuild is needed, but the Shaka e2e should be run once.
- **Behaviour parity of the `ffmpeg` path.** Today the bash script reads the source height itself from the mezzanine; Node derives it from `info.video.displayHeight` floored to even. These should agree for a mezzanine (normalise rounds down to even); verify on the fixtures.
- `ladder.mjs` currently imports nothing, so the move is clean; `complexity.mjs` imports from it and moves its import in step 1.

## Where this goes

Steps 2–6 are separate plans: (2) Title layout module, (3) settings schema, API, Postgres table and runtime Delivery module, (4) bench extraction and the workflow registry, (5) Settings and Workflows pages, (6) stage hand-off cleanup. Terms are defined in `CONTEXT.md`.
