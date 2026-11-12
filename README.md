# mediaCDN

PoC: a 4-quadrant video streamer on Google Cloud Media CDN. Each quadrant plays a user-selected VOD or live stream; only the focused quadrant has audio, and video ads can play in an unfocused quadrant.

See `docs/` for architecture and decisions.

## Layout
- `infra/` Terraform for Media CDN origins, routes, keyset, and Cloud Run
- `web/` React + Vite + TypeScript client (Shaka Player)
- `ad-service/` ad-decision API (Cloud Run)
- `catalog/` selectable stream list

## Local workflow
```
brew install ffmpeg                                  # once
node scripts/probe-sources.mjs                       # check the public sources
node scripts/fetch-sources.mjs [id ...]              # download titles into media/src/ (git-ignored)
bash scripts/package.sh <id> [--quick]               # ABR ladder -> origin/<id>/ (HLS + DASH, CMAF)
node tools/serve-origin.mjs                          # origin on :8788 (CORS, ranges, /live/<id>/ simulated live)
node tools/smoke-origin.mjs <id>                     # smoke-test the origin
node --test tools/                                   # live-simulation unit tests
cd web && npm run dev                                # player; pick Delivery = local
```
- Delivery `local` offers `<id>-hls`, `<id>-dash` and `live-<id>` (looped HLS live) for each packaged title.
- Simulated live is HLS only: DASH would need a new Period per loop because the media timestamps restart.
- Content is CC BY; see `docs/sources.md` for attribution.
