#!/usr/bin/env bash
# Generates tiny synthetic inputs that exercise each ingest case. Nothing here is committed.
# usage: generate.sh [outdir]   (default: pipeline/fixtures/out)
set -euo pipefail

out="${1:-$(cd "$(dirname "$0")" && pwd)/out}"
mkdir -p "$out"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
tone() { echo "sine=frequency=$1:sample_rate=48000:duration=2"; }

# Clean 16:9 with audio: the control case.
ff -f lavfi -i testsrc2=s=640x360:r=30:d=2 -f lavfi -i "$(tone 440)" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$out/clean.mp4"

# Silent, low-fps, flat-colour screen recording.
ff -f lavfi -i "color=c=white:s=640x360:r=10:d=2,drawbox=x=40:y=40:w=300:h=20:color=black:t=fill" \
  -c:v libx264 -pix_fmt yuv420p -an "$out/screen-silent.mp4"

# Portrait phone clip carrying a 90 degree display rotation.
ff -f lavfi -i testsrc2=s=360x640:r=30:d=2 -f lavfi -i "$(tone 330)" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$out/.phone-raw.mp4"
ff -display_rotation:v 90 -i "$out/.phone-raw.mp4" -c copy "$out/phone-rotated.mp4"
rm "$out/.phone-raw.mp4"

# Variable frame rate: frames dropped at random with their original timestamps kept.
ff -f lavfi -i testsrc2=s=640x360:r=30:d=4 -f lavfi -i "$(tone 220)" \
  -vf "select='gt(random(0),0.5)'" -fps_mode vfr -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$out/vfr.mp4"

# Two audio tracks.
ff -f lavfi -i testsrc2=s=640x360:r=30:d=2 -f lavfi -i "$(tone 440)" -f lavfi -i "$(tone 880)" \
  -map 0:v -map 1:a -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$out/multi-audio.mp4"

# 10-bit BT.2020 PQ. Best effort: needs an x264 build with high bit depth.
ff -f lavfi -i testsrc2=s=640x360:r=30:d=2 -f lavfi -i "$(tone 440)" \
  -c:v libx264 -pix_fmt yuv420p10le -x264-params colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc \
  -c:a aac -shortest "$out/hdr10.mp4" || echo "skipped hdr10.mp4" >&2

# Rejections: audio-only, and an MP4 cut in half (moov atom lost).
ff -f lavfi -i "$(tone 440)" -c:a aac "$out/audio-only.m4a"
head -c "$(($(wc -c <"$out/clean.mp4") / 2))" "$out/clean.mp4" >"$out/truncated.mp4"

echo "fixtures in $out"
