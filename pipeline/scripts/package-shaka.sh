#!/usr/bin/env bash
# Packages a mezzanine into CMAF HLS + DASH with Shaka Packager. Runs inside the worker image
# (pipeline/Dockerfile), where ffmpeg and packager are installed:
#   ffmpeg encodes every rung and the audio in ONE pass (so the source is decoded once), then
#   packager cuts them into chunks, keeping the file layout the origin, the catalog and the
#   verify stage already read: master.m3u8, manifest.mpd, media_N.m3u8, init-N.m4s, chunk-N-NNNNN.m4s
#   (video rungs 0..n-1, audio n).
# Env: INPUT mezzanine, OUT output directory, RUNGS "360:800 720:2800" (height:kbps),
#      SLUG and SRC_H for the log line, SEG segment seconds (default 4), PROGRESS for ffmpeg -progress.
set -euo pipefail

in=${INPUT:?INPUT is required}
out=${OUT:?OUT is required}
rungs=${RUNGS:?RUNGS is required}
slug=${SLUG:-title}
SEG=${SEG:-4}
tmp="$out/.rungs"

[ -f "$in" ] || { echo "missing $in" >&2; exit 1; }
mkdir -p "$out" "$tmp"
trap 'rm -rf "$tmp"' EXIT

# Keyframes every SEG seconds, so each segment starts on one and the packager cuts exactly there.
# The mezzanine is constant frame rate (normalise guarantees it), so the rate is a fixed fraction.
rate=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$in")
gop=$(awk -F/ -v f="$rate" -v s="$SEG" 'BEGIN { split(f, a, "/"); d = (a[2] ? a[2] : 1); printf "%d", (a[1] / d) * s + 0.5 }')
[ "$gop" -ge 1 ] || { echo "could not read the frame rate of $in" >&2; exit 1; }

# shellcheck disable=SC2086
set -- $rungs
n=$#

filter="[0:v]split=$n"
for i in $(seq 0 $((n - 1))); do filter="$filter[s$i]"; done
args=()
i=0
for r in "$@"; do
  h=${r%%:*}
  b=${r##*:}
  # setsar=1 after scale: scale=-2:240 of a 1280x720 source otherwise leaves sar=640:639.
  filter="$filter;[s$i]scale=-2:$h,setsar=1[v$i]"
  # Normalise guarantees 8-bit SDR BT.709, so say so explicitly: the tags do not reliably survive the
  # filter chain, and without them the playlist has no VIDEO-RANGE and the MPD no colour description.
  args+=(-map "[v$i]" -an -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p
    -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
    -b:v "${b}k" -maxrate "$((b * 3 / 2))k" -bufsize "$((b * 2))k"
    -g "$gop" -keyint_min "$gop" -sc_threshold 0 "$tmp/v$i.mp4")
  i=$((i + 1))
done

echo "packaging $slug (source ${SRC_H:-?}p) -> rungs:$rungs"
progress=(-stats)
[ -z "${PROGRESS:-}" ] || progress=(-nostats -progress "$PROGRESS")
ffmpeg -hide_banner -loglevel warning ${progress[@]+"${progress[@]}"} -y -i "$in" \
  -filter_complex "$filter" "${args[@]}" \
  -map 0:a:0 -vn -c:a aac -b:a 128k -ac 2 -ar 48000 "$tmp/a.mp4"

pk=()
for i in $(seq 0 $((n - 1))); do
  pk+=("in=$tmp/v$i.mp4,stream=video,init_segment=$out/init-$i.m4s,segment_template=$out/chunk-$i-\$Number%05d\$.m4s,playlist_name=media_$i.m3u8")
done
# lang=en and --default_language: without them the only audio rendition is DEFAULT=NO.
pk+=("in=$tmp/a.mp4,stream=audio,init_segment=$out/init-$n.m4s,segment_template=$out/chunk-$n-\$Number%05d\$.m4s,playlist_name=media_$n.m3u8,lang=en,hls_group_id=audio,hls_name=main")

# --generate_static_live_mpd: otherwise the MPD is type="dynamic" with a minimumUpdatePeriod.
packager "${pk[@]}" --quiet \
  --segment_duration "$SEG" --generate_static_live_mpd --default_language en \
  --hls_master_playlist_output "$out/master.m3u8" --hls_playlist_type VOD \
  --mpd_output "$out/manifest.mpd"

rm -rf "$tmp"
echo "done: $(ls "$out" | wc -l | tr -d ' ') files, $(du -sh "$out" | cut -f1)"
