#!/usr/bin/env bash
# Transcodes media/src/<slug>.mp4 into an ABR ladder and writes DASH (manifest.mpd) and
# HLS (master.m3u8) over the same CMAF segments into origin/<slug>/.
# Usage: RUNGS="<spec>" scripts/package.sh <slug>   (by hand, use: node scripts/package-title.mjs <slug> [--quick], which sets RUNGS)
# Env: RUNGS (required) the ladder as `height:kbps:maxrate:bufsize` tokens, e.g. "360:800:1200:1600 720:2800:4200:5600".
#      shared/src/ladder.ts (encodeSpec) writes it; this script holds no bitrate table of its own.
#      SRC_H source height, for the log line only.
#      INIT_TEMPLATE, CHUNK_TEMPLATE, HLS_MASTER, DASH_MANIFEST (required) the file names, from shared/src/title-layout.ts
#      (packagerEnv); `$Rep$` in a template is the representation number. ffmpeg's DASH muxer always writes the HLS
#      media playlists as media_<n>.m3u8, which the layout module names too; the test in scripts/ checks they agree.
#      PRINT_ARGS=1 prints the filter graph, the per-rung ffmpeg arguments and the naming arguments, one per line, and exits before
#      checking the input or touching anything (the test hook that checks the script uses the rungs it is given).
#      INPUT=<file> and OUT=<dir> override the default paths; PROGRESS=<url> is passed to ffmpeg's
#      -progress (e.g. pipe:1) so a caller can follow the encode.
set -euo pipefail

slug=${1:?usage: RUNGS="<spec>" package.sh <slug>}
rungs=${RUNGS:?RUNGS is required: the ladder as height:kbps:maxrate:bufsize tokens (see shared/src/ladder.ts, encodeSpec)}
init_template=${INIT_TEMPLATE:?INIT_TEMPLATE is required (see shared/src/title-layout.ts, packagerEnv)}
chunk_template=${CHUNK_TEMPLATE:?CHUNK_TEMPLATE is required (see shared/src/title-layout.ts, packagerEnv)}
hls_master=${HLS_MASTER:?HLS_MASTER is required (see shared/src/title-layout.ts, packagerEnv)}
dash_manifest=${DASH_MANIFEST:?DASH_MANIFEST is required (see shared/src/title-layout.ts, packagerEnv)}
root=$(cd "$(dirname "$0")/.." && pwd)
in="${INPUT:-$root/media/src/$slug.mp4}"
out="${OUT:-$root/origin/$slug}"
SEG=4

if [ -z "${PRINT_ARGS:-}" ]; then
  [ -f "$in" ] || { echo "missing $in (run: node scripts/fetch-sources.mjs $slug)" >&2; exit 1; }
  command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
fi

# Fills `$Rep$` in a name template with the representation number or placeholder in $2.
expand() { local t=$1; printf '%s' "${t//'$Rep$'/$2}"; }
# ffmpeg's own placeholder for the representation number.
rep='$RepresentationID$'
names=(-init_seg_name "$(expand "$init_template" "$rep")" -media_seg_name "$(expand "$chunk_template" "$rep")" -hls_master_name "$hls_master")

# shellcheck disable=SC2086
set -- $rungs
n=$#

filter="[0:v]split=$n"
for i in $(seq 0 $((n - 1))); do filter="$filter[s$i]"; done
args=()
i=0
for r in "$@"; do
  IFS=: read -r h b maxrate bufsize <<<"$r"
  [ -n "$bufsize" ] || { echo "bad rung \"$r\": expected height:kbps:maxrate:bufsize" >&2; exit 1; }
  filter="$filter;[s$i]scale=-2:$h[v$i]"
  args+=(-map "[v$i]" "-b:v:$i" "${b}k" "-maxrate:v:$i" "${maxrate}k" "-bufsize:v:$i" "${bufsize}k")
  i=$((i + 1))
done

if [ -n "${PRINT_ARGS:-}" ]; then
  printf '%s\n' "$filter" "${args[@]}" "${names[@]}" "$out/$dash_manifest"
  exit 0
fi

rm -rf "$out"
mkdir -p "$out"
echo "packaging $slug (source ${SRC_H:-?}p) -> rungs:$rungs"
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
  "${names[@]}" "$out/$dash_manifest"

echo "done: $(ls "$out" | wc -l | tr -d ' ') files, $(du -sh "$out" | cut -f1)"
