# pipeline

Ingest stage of the UGC transcoding pipeline: probe, validate, normalise. Design, decisions and the milestone 2-4 roadmap are in `../docs/plans/transcoding-pipeline.md`.

## Upload server

`bin/serve.mjs` runs a video through probe, validate, normalise, ladder, package (`scripts/package.sh`), verify and publish (into `origin/ugc-<name>/`), and streams each stage's status to the `/upload/` page. See `../docs/plans/upload-page.md`.

```
node bin/serve.mjs [--port 8790] [--work dir] [--origin dir]
```

### Packagers

The package stage has two backends, chosen with `PIPELINE_PACKAGER` when the server starts:

| Value | What runs | Output |
| --- | --- | --- |
| `ffmpeg` (default) | `scripts/package.sh` on the host | ffmpeg's DASH muxer writes HLS and DASH together |
| `shaka` | `scripts/package-shaka.sh` in the worker image, through `docker run` | ffmpeg encodes every rung in one pass, then Shaka Packager writes CMAF HLS and DASH |

`PIPELINE_PACKAGER=shaka bash scripts/dev.sh` starts the app with the Shaka backend. It needs Docker and the worker image (`docker build -t mediacdn-pipeline:dev pipeline/`; `PIPELINE_IMAGE` names a different one). The container runs with no network, no capabilities and your own user id, and sees the mezzanine read-only. Both backends write the same file layout (`master.m3u8`, `manifest.mpd`, `media_N.m3u8`, `init-N.m4s`, `chunk-N-NNNNN.m4s`), so verify, publish, the origin and the player do not care which was used. Shaka output adds `AVERAGE-BANDWIDTH`, `FRAME-RATE`, `VIDEO-RANGE`, an explicit VOD playlist type and a static MPD. The ladder is `shared/src/ladder.ts` (240p to 1080p, never upscaled). The Shaka path measures each title first (`src/complexity.mjs`, the Ladder stage) and encodes at constant quality, so screen recordings get a fraction of the bitrate of film; the ffmpeg path keeps the fixed table. Both scripts take their ladder from the caller (`RUNGS`, written by `encodeSpec` in `shared/src/ladder.ts`) and hold no table or bitrate arithmetic of their own; `node scripts/package-title.mjs <id>` packages a title by hand.

It listens on loopback only, answers only to `localhost` hosts and to the dev server's origin (`PIPELINE_ALLOWED_ORIGINS=http://localhost:5173,...` to change it), and sends no CORS headers; the browser reaches it through Vite's `/api/pipeline` proxy. It runs ffmpeg on whatever it is sent, so it is for local use.

```
node bin/ingest.mjs <file> [--id slug] [--work dir] [--profile file]
node --test .                       # unit tests + end-to-end on generated fixtures (needs ffmpeg)
bash fixtures/generate.sh [outdir]  # synthetic inputs: screen recording, rotated phone, VFR, HDR, ...
```

In Docker (pinned ffmpeg with zimg and libvmaf, plus Shaka Packager):

```
docker compose run --rm worker /in/bbb.mp4     # reads ../media/src, writes ./work
```

Exit codes: 0 ok, 1 usage error, 2 rejected by validation, 3 normalise failed. Rejections and failures are recorded in `work/<jobKey>/job.json` with stable `E_*` codes.
