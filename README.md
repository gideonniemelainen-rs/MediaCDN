# mediaCDN

PoC: a 4-quadrant video streamer on Google Cloud Media CDN. Each quadrant plays a user-selected VOD or live stream; only the focused quadrant has audio, and video ads can play in an unfocused quadrant.

See `docs/` for architecture and decisions.

## Layout
- `infra/` Terraform for Media CDN origins, routes, keyset, and Cloud Run; empty, not written yet
- `web/` React + Vite + TypeScript client (Shaka Player)
- `ad-service/` ad-decision API (Cloud Run); empty, planned in `docs/plans/ad-injection-plan.md`
- `catalog/` selectable stream list; empty, the catalog is built from `web/src/catalog.ts` and each delivery's `index.json`
- `shared/` TypeScript used by the web app, the pipeline and the tools, with no build step (Node runs it, Vite bundles it); the ABR ladder and the Title layout (file names, URLs, the title index), see `docs/plans/shared-ladder.md` and `docs/plans/title-layout.md`
- `pipeline/` UGC transcoding pipeline (ffmpeg + Shaka Packager) and its local upload server; see `docs/plans/transcoding-pipeline.md` and `docs/plans/upload-page.md`

## Local workflow
Everything at once: `bash scripts/dev.sh` starts the database, origin, upload/auth server and Vite, reuses anything already running, and stops what it started on Ctrl-C (`--stop-db` also stops Postgres, `--no-origin` skips the origin). `PIPELINE_PACKAGER=shaka bash scripts/dev.sh` packages uploads with Shaka Packager in the worker image (needs Docker; see `pipeline/README.md`). The individual commands:
```
brew install ffmpeg                                  # once
node scripts/probe-sources.mjs                       # check the public sources
node scripts/fetch-sources.mjs [id ...]              # download titles into media/src/ (git-ignored)
node scripts/package-title.mjs <id> [--quick]        # ABR ladder -> origin/<id>/ (HLS + DASH, CMAF); the rungs come from shared/
node tools/serve-origin.mjs                          # origin on :8788 (CORS, ranges, /live/<id>/ simulated live)
node tools/smoke-origin.mjs <id>                     # smoke-test the origin
node --test shared/ scripts/ tools/                  # ladder, packaging entry and live-simulation tests
node pipeline/bin/ingest.mjs <file> [--id slug]      # validate + normalise an upload -> pipeline/work/<key>/
node --test pipeline/                                # pipeline unit + end-to-end tests (needs ffmpeg)
docker compose -f pipeline/compose.yaml up -d db     # Postgres for accounts and history (once per boot)
(cd pipeline && npm install)                         # once: the pg driver
node pipeline/bin/serve.mjs                          # upload + auth API on :8790; sign in as admin / admin (first start), then open /upload/
cd web && npm run dev                                # player; each quadrant picks its own delivery
```
- Each quadrant has its own Delivery picker, so one title can be compared across sources side by side (the "compare deliveries" preset loads Big Buck Bunny from the local origin, both S3 buckets and Media CDN). The telemetry table marks the best value per metric when the same stream plays in several quadrants.
- Deliveries and the `web/.env.local` variable each one reads. These are the **defaults**: an admin can override a delivery's base URL or switch it off in the settings (stored in Postgres, served by the pipeline API at `GET /api/pipeline/settings`), and an override wins over the variable. With the API down the player runs on the variables alone:

| Delivery | Meaning | Variable |
| --- | --- | --- |
| `direct` | public third-party URL | none |
| `local` | packaged origin on this machine | `VITE_LOCAL_BASE` (default `http://localhost:8788`) |
| `s3-near` | S3 bucket close to you, no CDN | `VITE_S3_NEAR_BASE` (falls back to the older `VITE_S3_BASE`) |
| `s3-far` | the same content in a distant bucket | `VITE_S3_FAR_BASE` |
| `cdn-public` | Media CDN in front of a public origin | `VITE_CDN_BASE` |
| `cdn-s3` | Media CDN in front of S3 | `VITE_CDN_BASE` |

- Delivery `local` offers `<id>-hls`, `<id>-dash` and `live-<id>` (looped HLS live) for each packaged title. The S3 deliveries and `cdn-s3` offer the HLS and DASH copies listed in their `index.json`. A quadrant whose source is not configured says which variable to set.
- Simulated live is HLS only: DASH would need a new Period per loop because the media timestamps restart.
- Content is CC BY; see `docs/sources.md` for attribution.
