#!/usr/bin/env bash
# Transcodes media/src/<slug>.mp4 into an ABR ladder and writes DASH (manifest.mpd) and
# HLS (master.m3u8) over the same CMAF segments into origin/<slug>/.
# Usage: scripts/package.sh <slug> [--quick]   (--quick: 360p + 720p only)
# Env: INPUT=<file> and OUT=<dir> override the default paths; PROGRESS=<url> is passed to ffmpeg's
# -progress (e.g. pipe:1) so a caller can follow the encode.
set -euo pipefail

slug=${1:?usage: package.sh <slug> [--quick]}
quick=${2:-}
root=$(cd "$(dirname "$0")/.." && pwd)
in="${INPUT:-$root/media/src/$slug.mp4}"
out="${OUT:-$root/origin/$slug}"
SEG=4

[ -f "$in" ] || { echo "missing $in (run: node scripts/fetch-sources.mjs $slug)" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }

src_h=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$in")

# height:video-kbps; rungs taller than the source are skipped (no upscaling)
if [ "$quick" = "--quick" ]; then
  rungs="360:800 720:2800"
else
  rungs="240:400 360:800 480:1400 720:2800 1080:5000"
fi
sel=""
for r in $rungs; do
  if [ "${r%%:*}" -le "$src_h" ]; then sel="$sel $r"; fi
done
[ -n "$sel" ] || sel="$src_h:800"
# shellcheck disable=SC2086
set -- $sel
n=$#

filter="[0:v]split=$n"
for i in $(seq 0 $((n - 1))); do filter="$filter[s$i]"; done
args=()
i=0
for r in "$@"; do
  h=${r%%:*}
  b=${r##*:}
  filter="$filter;[s$i]scale=-2:$h[v$i]"
  args+=(-map "[v$i]" "-b:v:$i" "${b}k" "-maxrate:v:$i" "$((b * 3 / 2))k" "-bufsize:v:$i" "$((b * 2))k")
  i=$((i + 1))
done

rm -rf "$out"
mkdir -p "$out"
echo "packaging $slug (source ${src_h}p) -> rungs:$sel"
# Empty-array expansion is an error under `set -u` on bash 3.2 (macOS), hence the + form.
progress=(-stats)
[ -z "${PROGRESS:-}" ] || progress=(-nostats -progress "$PROGRESS")
ffmpeg -hide_banner -loglevel warning ${progress[@]+"${progress[@]}"} -y -i "$in" \
  -filter_complex "$filter" "${args[@]}" -map 0:a:0 \
  -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -sc_threshold 0 \
  -force_key_frames "expr:gte(t,n_forced*$SEG)" \
  -c:a aac -b:a 128k -ac 2 \
  -f dash -seg_duration "$SEG" -use_template 1 -use_timeline 1 -hls_playlist 1 -dash_segment_type mp4 \
  -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -init_seg_name 'init-$RepresentationID$.m4s' \
  -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.m4s' \
  "$out/manifest.mpd"

echo "done: $(ls "$out" | wc -l | tr -d ' ') files, $(du -sh "$out" | cut -f1)"
