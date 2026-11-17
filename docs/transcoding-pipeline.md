# Transcoding pipeline

Status: milestone 1 (ingest: probe, validate, normalise) built 2026-11-12; milestones 2-4 designed, not started.

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

- **Mezzanine:** x264 CRF 12 plus FLAC in Matroska. It is a lossless-ish intermediate, not a delivery encode.
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

## Milestone 3: artifacts (designed)

Poster frame, seek-preview sprite sheet with WebVTT, optional Whisper captions as WebVTT renditions, optional audio-only rendition.

## Milestone 4: quality gates and orchestration (designed)

VMAF per rung with a floor (re-encode or reject), retries with backoff, dead letter, status events (`queued|probing|rejected|encoding|packaging|ready|failed`) and stage timings. A local queue first, behind an interface that maps to Pub/Sub plus Cloud Run Jobs.

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

- **Mezzanine size.** CRF 12 is expensive: 384 MB for 10 minutes of 720p. 4K at 2 hours would be tens of GB. Needs a budget decision before cloud (lower CRF, or encode straight from the source when it is already clean).
- **Tonemap is verified in the container only.** The Homebrew ffmpeg has no `zscale`, so the HDR integration test skips locally. In the container (arm64), a PQ/BT.2020 10-bit fixture came out as 8-bit `yuv420p` with BT.709 primaries, transfer and matrix. CI should run the suite in the image so this stays covered.
- **No libvmaf in the pinned ffmpeg.** The johnvansickle 7.0.2 static builds lack it. Milestone 4 needs a different ffmpeg source (another static build or a source build); the Dockerfile only warns for now.
- **Container pins.** The image builds on arm64 (2026-11-12) with ffmpeg 7.0.2 pinned by sha256 per architecture, and Shaka Packager v3.4.2 (`packager --version` runs). Only the arm64 path has been built. The amd64 hash is pinned from the published archive but the amd64 image and the `packager-linux-x64` asset are untested.
- **Loudness default.** On at -16 LUFS is a policy choice.
- **Probe-only validation.** A file can probe fine and still fail to decode midway; that surfaces as `E_DECODE_FAILED` (exit 3) during normalise, not at validate.

## Verification

```
node --test pipeline/                       # unit tests plus end-to-end ingest on generated fixtures
bash pipeline/fixtures/generate.sh          # fixtures into pipeline/fixtures/out/ (git-ignored)
node pipeline/bin/ingest.mjs media/src/bbb.mp4
docker build pipeline/                      # asserts zscale, loudnorm, bwdif, libx264; runs packager --version
```
