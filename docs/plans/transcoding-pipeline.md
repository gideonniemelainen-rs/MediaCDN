# Transcoding pipeline

Status: milestone 1 (ingest: probe, validate, normalise) built 2026-11-12. Milestone 2 started 2026-11-23: Shaka Packager packaging is built behind `PIPELINE_PACKAGER=shaka` with the fixed ladder (see "Shaka packaging in the upload flow"); the content-aware ladder is not started. Milestones 3-4 designed, not started.

The goal is a production-grade path from user-generated uploads (phone video, HD camera files, screen recordings) to HLS + DASH (CMAF) assets for the streaming app. `scripts/package.sh` stays as the quick local packager until milestone 2 replaces it. It assumes a clean 16:9 file with exactly one audio track and fixed bitrates.

## Stages

```
upload -> probe -> validate -> normalise -> ladder -> encode -> package CMAF -> artifacts -> publish + asset.json
          |_______ M1 _______|__________ M2 ____________________|    M3          M2/M3
                                                    quality gate (VMAF), retries, status events: M4
```

Each stage is a pure planning function plus a thin runner, as in `tools/live.mjs`. Stages hand over through `job.json` (and later `asset.json`).

## Milestone 1: ingest

`node pipeline/bin/ingest.mjs <file> [--id slug]` writes `pipeline/work/<jobKey>/{job.json,mezzanine.mkv}`.

| Module | Role |
| --- | --- |
| `src/probe.mjs` | `ffprobe` to a `SourceInfo`: rotation, VFR, HDR, bit depth, SAR, audio tracks. `summarise` is pure. |
| `src/validate.mjs` | Accept or reject with stable `E_*` codes; `W_*` warnings describe what normalise will fix. |
| `src/normalise.mjs` | Plans the ffmpeg run to a uniform mezzanine. |
| `src/job.mjs` | Job key and slug. |
| `profiles/default.json` | Limits and normalise settings. The profile is part of the job key. |

**Exit codes:** 0 ok, 1 usage error, 2 rejected, 3 normalise failed.

### What normalise guarantees

- Upright (rotation applied), square pixels, even dimensions.
- Constant frame rate. The nominal rate is the average for VFR sources, clamped to 10-60 and snapped to the nearest standard rate (10, 15, 24, 25, 30, 50, 60). Low-rate screen recordings stay at 10 rather than being forced to 30.
- 8-bit SDR BT.709, tagged as such. HDR (PQ/HLG) is tonemapped with `hable`.
- Exactly one stereo 48 kHz audio track. Silent sources get synthesised silence, so every asset has an audio adaptation set. With several tracks, the default-disposition one is used. Loudness is normalised to -16 LUFS (single-pass `loudnorm`).
- All metadata is stripped (GPS and device tags in UGC).

### Decisions

- **Mezzanine:** x264 CRF 18 plus FLAC in Matroska. It is a working intermediate, not a delivery encode, and it is never uploaded to S3 (only packaged ladders are). Measured on a 60 s `bbb.mp4` clip: CRF 18 cuts mezzanine video bytes by 59% versus CRF 12 for about 0.002 SSIM on a 720p/2.8 Mbps rung; CRF 23 loses about 0.008. Re-check with libvmaf on live action, screen recording and noisy clips before treating it as final.
- **Idempotency:** the job key is the sha256 of the source plus pipeline version plus profile. A `normalised` job is a no-op, and output is written to `.part` then renamed.
- **Single-pass loudnorm:** two-pass is more accurate but doubles audio time. It is revisitable.

### Findings while building it

- `loudnorm` resamples to 192 kHz internally, so `aresample` must follow it.
- Its oversized first frame makes the FLAC encoder fail (`invalid block size`) on short inputs, so `asetnsamples` is needed.
- Mono sources failed when upmixed after `loudnorm`, so the channel layout is fixed before it.
- Mezzanine size is the main cost: about 384 MB for the 10-minute 720p `bbb.mp4`. See Risks.

## Milestone 2: ladder and CMAF packaging (designed)

- **Content-aware ladder.** A quick complexity probe classifies screen content versus film. Screen content gets tuned encodes (lower bitrates, resolution kept high so text stays sharp). Capped CRF with VBV replaces fixed bitrates.
- **Keyframes on segment boundaries.** `-g` and `keyint_min` are derived from the CFR rate, and a check on packets asserts alignment. Normalise already provides the stable frame rate this needs.
- **Shaka Packager** produces CMAF HLS + DASH with `AVERAGE-BANDWIDTH`, `FRAME-RATE` and correct DASH `type`.
- **Output layout stays compatible** with what `web/src/catalog.ts`, `tools/live.mjs` and `tools/smoke-origin.mjs` read: `<id>/master.m3u8`, `manifest.mpd`, `media_N.m3u8`, `init-N.m4s`, `chunk-N-NNNNN.m4s`. If Shaka's naming differs, use its naming templates or a rename step rather than changing the consumers.
- A rung at or below 360p is always emitted, because unfocused quadrants cap at 360 (`web/src/QuadrantPlayer.tsx`).

### Shaka Packager spike (`pipeline/spike/shaka-spike.sh`)

Packaged the `selftest` mezzanine (3 video rungs plus audio) with Shaka v3.4.2 in the worker image.

- **Naming needs no rename step and no consumer changes.** Explicit per-stream `init_segment`, `segment_template` (`chunk-N-$Number%05d$.m4s`) and `playlist_name` (`media_N.m3u8`) reproduce ffmpeg's layout exactly. Video rungs are 0..k-1 and audio is k, as before. `tools/smoke-origin.mjs` passes all 8 checks against the output, including the simulated live playlist.
- **Packet check:** the first packet of every sampled video segment is a keyframe on a 4 s boundary (`-g` = fps x 4, `-keyint_min` the same, `-sc_threshold 0`).
- **Flags that are required:** `--generate_static_live_mpd` (otherwise the MPD is `type="dynamic"` with `minimumUpdatePeriod`), and `lang=en` on the audio stream plus `--default_language en` (otherwise the only audio rendition is `DEFAULT=NO`).
- **Ladder encodes need `setsar=1` after `scale`:** `scale=-2:240` from 1280x720 gave `sar=640:639`.
- **Gained over ffmpeg's muxer:** `AVERAGE-BANDWIDTH`, `FRAME-RATE`, `VIDEO-RANGE=SDR`, a `#EXT-X-PLAYLIST-TYPE:VOD` and proper `ENDLIST`.
- **Differences to watch:** no `#EXT-X-PROGRAM-DATE-TIME` or `#EXT-X-MEDIA-SEQUENCE` in the source playlists (the live simulator generates its own, so nothing breaks), `TARGETDURATION` is 5 for 4 s segments, audio segments are 4.011/3.989 s, and the MPD `frameRate` is unreduced (`12288/512`).
- **Checked since (2026-11-23):** playback in Shaka Player in the browser (HLS, DASH and the simulated live all play), and the amd64 image (built and run, see the section below).

### Shaka packaging in the upload flow (built 2026-11-23)

`PIPELINE_PACKAGER=shaka` makes the upload server's package stage run `pipeline/scripts/package-shaka.sh` in the worker image with `docker run` (`src/packagers.mjs` builds the command, `src/steps.mjs` runs it). The default stays `scripts/package.sh`.

- **One encode pass.** The spike encoded each rung separately. The script decodes the mezzanine once, splits it to every rung, and writes the audio in the same ffmpeg run. Progress comes from `-progress pipe:1`, as for `package.sh`.
- **Ladder.** `src/ladder.mjs` has the rung table (the same heights and bitrates as `package.sh`) and never upscales. A 360p-or-lower rung always exists. The content-aware ladder will replace this table.
- **Keyframes and colour.** `-g` and `-keyint_min` are the frame rate times 4 s, with `-sc_threshold 0`. The rungs are tagged BT.709 explicitly, because the mezzanine's tags did not reliably survive the filter chain and the master playlist then had no `VIDEO-RANGE`.
- **Isolation.** The container has no network, drops all capabilities and runs as the host user, with the mezzanine mounted read-only. Uploads are untrusted media, so this is also a step toward the Docker-isolation answer to the "server runs ffmpeg on arbitrary files" risk.
- **Verify** gained two checks that apply to both packagers: every HLS playlist is complete (`#EXT-X-ENDLIST`) and the MPD is `type="static"`.
- **Failures** say what to do: Docker missing or not running, or the image not built.
- **Evidence.** `src/shaka.e2e.test.mjs` runs the real stages through a real server and the real image: 4 s segments that all start on a keyframe, rung sizes and square pixels, colour tags, VOD and static manifests, a re-upload reusing the mezzanine, and a missing image failing cleanly with nothing published. Output also passes `tools/smoke-origin.mjs` (including the simulated live) and plays in the browser over HLS, DASH and live.
- **amd64 (2026-11-23).** `docker build --platform linux/amd64` succeeds (pinned ffmpeg hash and Shaka `packager-linux-x64` both verified by the build), the image reports x86_64 with Shaka Packager v3.4.2 and ffmpeg 7.0.2, and `package-shaka.sh` packaged a clip with it under emulation on the arm64 host. Not run on a native amd64 machine or in CI.
- **Not done:** the content-aware ladder, VMAF, and running the default packager in the image too.

### libvmaf options (decision pending)

- The pinned johnvansickle 7.0.2 static ffmpeg has no libvmaf. Debian bookworm (ffmpeg 5.1) and trixie (7.1.5) ffmpeg lack it too, and Debian has no vmaf packages.
- Homebrew ffmpeg 9.0.2 on the host has libvmaf, so local measurement works today.
- Candidates for the image: a static build that includes libvmaf (johnvansickle `release`/`git` or BtbN, which need a pinned version and sha256), or a source build of libvmaf in a multi-stage Dockerfile.
- Measured on a 60 s `bbb.mp4` clip (720p/2.8 Mbps rung, VMAF vs source): from source 96.0, via CRF 12 mezzanine 95.2, CRF 16 94.6, CRF 18 93.8, CRF 23 90.3. CRF 18 costs about 1.4 points against CRF 12 on this worst-case clip (rung bitrate above the source bitrate).

## Milestone 3: artifacts (designed)

Poster frame, seek-preview sprite sheet with WebVTT, optional Whisper captions as WebVTT renditions, optional audio-only rendition.

## Milestone 4: quality gates and orchestration (designed)

VMAF per rung with a floor (re-encode or reject), retries with backoff, dead letter, status events (`queued|probing|rejected|encoding|packaging|ready|failed`) and stage timings. A local queue first, behind an interface that maps to Pub/Sub plus Cloud Run Jobs.

Partly in place locally: the upload server (`pipeline/bin/serve.mjs`, see `upload-page.md`) already runs the stages as a graph (`pipeline/src/stages.mjs`, `run.mjs`) with per-stage status, timing and progress, one job at a time, persisted under `pipeline/work/jobs/`. What is still missing is VMAF, retries and dead-lettering, and a queue interface for Pub/Sub.

## DAM integration

The DAM is a consumer and a validator, not a dependency. `asset.json` carries `id`, source hash, probe facts, warnings, renditions, artifacts and pipeline version, plus `license`, `attribution` and `sourceUrl` from `media/sources.json`. Making `web/src/catalog.ts` data-driven from it (the empty `catalog/` dir) is a follow-up.

## Cloud mapping

| Local | Cloud |
| --- | --- |
| `pipeline/work/` | GCS bucket (uploads, mezzanine, outputs) |
| compose `worker` | Cloud Run Job per upload |
| local queue | Pub/Sub |
| MinIO (`--profile publish`) | GCS behind Media CDN (`cdn-s3` delivery in the catalog) |

## Risks

- **Mezzanine size.** Decided: CRF 18 (was 12, 384 MB for 10 minutes of 720p). Remaining levers: delete the mezzanine after packaging (bucket lifecycle rule), AAC instead of FLAC (FLAC is about 9 MB per minute), and passthrough of already-clean sources.
- **Tonemap is verified in the container only.** The Homebrew ffmpeg has no `zscale`, so the HDR integration test skips locally. In the container (arm64), a PQ/BT.2020 10-bit fixture came out as 8-bit `yuv420p` with BT.709 primaries, transfer and matrix. CI should run the suite in the image so this stays covered.
- **No libvmaf in the pinned ffmpeg.** The johnvansickle 7.0.2 static builds lack it. Milestone 4 needs a different ffmpeg source (another static build or a source build); the Dockerfile only warns for now.
- **Container pins.** The image builds on arm64 (2026-11-12) with ffmpeg 7.0.2 pinned by sha256 per architecture, and Shaka Packager v3.4.2 (`packager --version` runs). Both architectures now build (amd64 under emulation on 2026-11-23, with `packager-linux-x64` verified); only arm64 has been run natively.
- **Loudness default.** On at -16 LUFS is a policy choice.
- **Probe-only validation.** A file can probe fine and still fail to decode midway; that surfaces as `E_DECODE_FAILED` (exit 3) during normalise, not at validate.

## Verification

```
node --test pipeline/                       # unit tests plus end-to-end ingest on generated fixtures
bash pipeline/fixtures/generate.sh          # fixtures into pipeline/fixtures/out/ (git-ignored)
node pipeline/bin/ingest.mjs media/src/bbb.mp4
docker build pipeline/                      # asserts zscale, loudnorm, bwdif, libx264; runs packager --version
```
