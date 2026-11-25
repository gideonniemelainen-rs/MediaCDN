# Transcoding pipeline

Status: milestone 1 (ingest: probe, validate, normalise) built 2026-11-12. Milestone 2 started 2026-11-23: Shaka Packager packaging is built behind `PIPELINE_PACKAGER=shaka` with the fixed ladder (see "Shaka packaging in the upload flow"); the content-aware ladder is built for the Shaka path (2026-11-23, see "Content-aware ladder"). Milestones 3-4 designed, not started.

The goal is a production-grade path from user-generated uploads (phone video, HD camera files, screen recordings) to HLS + DASH (CMAF) assets for the streaming app. `scripts/package.sh` stays as the quick local packager until milestone 2 replaces it (it takes its ladder from the caller since 2026-11-25; by hand, run `node scripts/package-title.mjs <id>`). It assumes a clean 16:9 file with exactly one audio track and fixed bitrates.

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
- **Output layout stays compatible** with what the origin, the verify stage and the web catalog read, defined in `shared/src/title-layout.ts` (since 2026-11-25 both packagers are handed the names, see `title-layout.md`): `<id>/master.m3u8`, `manifest.mpd`, `media_N.m3u8`, `init-N.m4s`, `chunk-N-NNNNN.m4s`. If Shaka's naming differs, use its naming templates or a rename step rather than changing the consumers.
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
- **Ladder.** `shared/src/ladder.ts` has the rung table (the only copy of the table: `package.sh` and `package-shaka.sh` take it as `RUNGS` from the caller) and never upscales. A 360p-or-lower rung always exists. It is the ffmpeg packager's ladder and the fallback for the next section.
- **Keyframes and colour.** `-g` and `-keyint_min` are the frame rate times 4 s, with `-sc_threshold 0`. The rungs are tagged BT.709 explicitly, because the mezzanine's tags did not reliably survive the filter chain and the master playlist then had no `VIDEO-RANGE`.
- **Isolation.** The container has no network, drops all capabilities and runs as the host user, with the mezzanine mounted read-only. Uploads are untrusted media, so this is also a step toward the Docker-isolation answer to the "server runs ffmpeg on arbitrary files" risk.
- **Verify** gained two checks that apply to both packagers: every HLS playlist is complete (`#EXT-X-ENDLIST`) and the MPD is `type="static"`.
- **Failures** say what to do: Docker missing or not running, or the image not built.
- **Evidence.** `src/shaka.e2e.test.mjs` runs the real stages through a real server and the real image: 4 s segments that all start on a keyframe, rung sizes and square pixels, colour tags, VOD and static manifests, a re-upload reusing the mezzanine, and a missing image failing cleanly with nothing published. Output also passes `tools/smoke-origin.mjs` (including the simulated live) and plays in the browser over HLS, DASH and live.
- **amd64 (2026-11-23).** `docker build --platform linux/amd64` succeeds (pinned ffmpeg hash and Shaka `packager-linux-x64` both verified by the build), the image reports x86_64 with Shaka Packager v3.4.2 and ffmpeg 7.0.2, and `package-shaka.sh` packaged a clip with it under emulation on the arm64 host. Not run on a native amd64 machine or in CI.
- **Not done:** VMAF in the pipeline, and running the default packager in the image too.

### Content-aware ladder (built 2026-11-23, Shaka path only)

A new **Ladder** stage sits between normalise and package. It measures the title, then chooses the rungs the package stage encodes.

- **Probe (`src/complexity.mjs`).** Three 6 s windows (a clip under 18 s is sampled whole) are encoded at constant quality, CRF 21, at every candidate height in one ffmpeg pass per window. A window's output size over its length is the bitrate that quality costs at that height. About 1 s per title on the host.
- **Plan (`planLadder` in `shared/src/ladder.ts`, pure).** Each rung's rate is the measured average, rounded to 10 kbps and clamped per height (for example 120 to 1200 kbps at 360p, 300 to 4200 at 720p; the ceiling is 1.5x the fixed table). A rung is dropped when the next one up costs less than 1.3x as much (same bitrate, so take the sharper picture). The tallest rung at or below 360p is never dropped, because unfocused quadrants cap there. Content under 0.02 bits per pixel per frame at 720p is classed `screen` and loses its sub-360p rungs, since 240p text is unreadable. Film and screen recordings in this repo sit at 0.04 to 0.12 and 0.004 to 0.007.
- **Encode.** `package-shaka.sh` takes `CRF` and encodes each rung at that quality capped by VBV at 1.5x the rung rate, so the rate is the title's own instead of a target. Without `CRF` it behaves as before.
- **Fixed ladder, still.** The ffmpeg packager encodes each rung at its target rate, not at constant quality, so the stage reports "fixed ladder" for it. A failed probe, or an unknown frame rate, also falls back to the fixed table and never fails the upload.
- **Constants live in code, not the profile**, because the profile is hashed into the job key and changing it would invalidate every cached mezzanine.
- **Result.** On the clips in this repo (720p rungs, CRF 21): the 10-minute `bbb.mp4` gets 240p to 720p at 180, 370, 570 and 1050 kbps (2.2 Mbps in total against 5.4 for the fixed table); two screen recordings get 360p, 480p and 720p at about 120, 190 and 300 to 330 kbps (0.6 Mbps in total, 11 to 12%); a synthetic stress clip stays near the fixed table (4.3 Mbps, 79%).
- **The probe matches the real encode's keyframes.** It encodes with a keyframe every 4 s (`-g`, `-keyint_min`, `-sc_threshold 0`, the same as `package-shaka.sh`) because spacing costs bits. Checked against the video segments of two packaged titles (summed from the `chunk-N-*.m4s` files): a 30 s film clip packaged at 229, 395, 588 and 874 kbps was probed at 235, 415, 636 and 945 with matched keyframes (222, 391, 596 and 866 with ffmpeg's default spacing); a 12 s screen recording packaged at 51, 78 and 135 kbps was probed at 52, 78 and 138 (45, 68 and 116 by default). Both settings land within 13% and mostly within 8%. Matching the keyframes is closer on the screen recording and a little high on the film clip, whose probe sampled 18 of its 30 s; it is kept because it is the encode that actually runs, not because it won on two clips.
- **Quality check** (VMAF at the 720p rung against a lossless 720p reference of an 8 s window, host libvmaf; the fixed 2800 kbps ladder for comparison):

  | Clip | CRF 23 | CRF 21 | CRF 19 | 2800 kbps |
  | --- | --- | --- | --- | --- |
  | bbb (film) | 93.6 @ 1639 | 95.4 @ 2014 | 96.7 @ 2480 | 97.2 @ 3039 |
  | screen recording, 30 fps | 95.7 @ 216 | 96.0 @ 242 | 96.4 @ 272 | 97.2 @ 786 |
  | screen recording, 50 fps | 93.0 @ 521 | 94.6 @ 598 | 95.2 @ 691 | 97.0 @ 2190 |
  | synthetic | 97.0 @ 2319 | 97.8 @ 2786 | 98.6 @ 3303 | 98.0 @ 2865 |

  Each cell is VMAF @ kbps for that window (the kbps differ from the ladder numbers above because the windows differ). CRF 21 was chosen because it keeps every clip at 94.6 or more; CRF 23 went to 93.0. It is lower than the fixed ladder by 0.2 to 2.4 VMAF in exchange for 27 to 66% of the bits on real content. That trade is a judgement, not a measurement of what viewers see, and the numbers come from four clips and one window each.
#### Why not the fixed ladder

The fixed table (240p 400, 360p 800, 480p 1400, 720p 2800, 1080p 5000 kbps) is a guess about an average title. Every title pays that guess, and the error runs both ways.

| | Fixed ladder | Content-aware ladder |
| --- | --- | --- |
| Rate for 720p | 2800 kbps for everything | 300 to 330 kbps for a screen recording, 1050 for `bbb.mp4`, 2670 for a synthetic stress clip, up to 4200 for noisy content |
| Easy content (screen recordings, slides, animation) | 3 to 19 times the bits the CRF probe needed at 720p (333 and 150 kbps on the two screen recordings, 1048 on `bbb.mp4`), for 0.2 to 2.4 more VMAF | about 11% of the fixed total, VMAF 94.6 to 96.4 against 97.0 to 97.2 |
| Hard content (noise, fast motion) | no headroom: a title that needs more than 2800 kbps at 720p gets a fixed rate and lower quality. Not measured here: the synthetic stress clip needed 2650, just under the table, and no real noisy clip was tried | rate follows the content, to 1.5x the fixed table |
| Rungs | every title gets every rung, so near-duplicate rungs (480p and 720p at almost the same rate) waste storage and give ABR choices that do not differ | a rung is dropped when the next one up costs less than 1.3x as much |
| Text | 240p rung that nobody can read | no sub-360p rung for screen-like content |
| Cost to find out | none | about 0.5 to 1.4 s per title on the host, one extra stage, falling back to the fixed table if it fails |

What this buys, in this project's terms:
- **Storage and egress.** On the repo's clips the planned total is 40% of the fixed table's for `bbb.mp4` and 11 to 12% for the two screen recordings. Measured on the packaged video segments of the browser uploads, a 30 s film clip's four rungs averaged 2.1 Mbps in total (39% of the 5.4 Mbps fixed total) and a 12 s screen recording's three rungs 0.26 Mbps (5%); audio, about 128 kbps either way, is extra. Egress is what a CDN bills for, and what the S3 and Media CDN comparisons will measure, so the saving applies to every viewer.
- **Quality that follows the content.** A constant-quality encode gives each title about the same picture quality (VMAF in the mid 90s here) instead of a quality that depends on how hard the title is. The fixed ladder gives a constant bitrate, which is the same thing only for an average title.
- **Better ABR choices.** On a slow link the player can still step down to a rung that is meaningfully cheaper, and on a fast one it is not offered five rungs that look the same.
- **Honest limits.** CRF 21 is 0.2 to 2.4 VMAF below the fixed ladder on these clips, so this is a saving bought with a small quality margin, not a pure win; the numbers are four clips and one window each; and the rates on the stage are estimates (the probe sampled part of the title).

A consequence for the benchmarks: bitrate and startup figures now depend on the title. A screen recording served at 300 kbps is a poor test of delivery throughput, so compare deliveries on the same title (the app already does) and use a film-like title when throughput is the point. Saved runs from before this change were measured on fixed-ladder titles, and the sample titles (`bbb`, `sprite-fright` and the others) still are.

**Browser check (2026-11-23).** A 30 s film clip and a 12 s screen recording uploaded through the page: the Ladder stage showed 4 rungs, "film-like" at 0.039 bits per pixel, and 3 rungs, "screen-like" at 0.004 with 240p left out and its reason; both published, passed verify and played. The packaged master playlists carried the chosen resolutions; their bandwidths include the audio rendition (film peaks 469 to 1432 kbps, screen 60 to 146), and take away 128 kbps and the film's 720p peak is at the 1.5x cap of its rung.

**Reading the master playlist.** Shaka's `BANDWIDTH` and `AVERAGE-BANDWIDTH` for a variant include the audio rendition (128 kbps here), so they are higher than the video rung's rate. My first comparison of the Ladder panel against the master (240p: 222 probed, 360 "packaged") mistook that for a probe error; against the video segments alone the probe was within about 3% on the film clip.
- **Not done:** the threshold and bounds are tuned on those clips only; there is no VMAF gate in the pipeline (the image's ffmpeg has no libvmaf, see below); sources shorter than 1080p but taller than 720p (such as the 1920x1020 recordings) get no rung above 720p, as before; the ffmpeg packager is unchanged.

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
