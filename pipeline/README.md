# pipeline

Ingest stage of the UGC transcoding pipeline: probe, validate, normalise. Design, decisions and the milestone 2-4 roadmap are in `../docs/transcoding-pipeline.md`.

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
