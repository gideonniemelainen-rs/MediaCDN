#!/bin/sh
# Spike: package one mezzanine with Shaka Packager and name the output like ffmpeg's DASH/HLS muxer
# (media_N.m3u8, init-N.m4s, chunk-N-NNNNN.m4s) so web/src/catalog.ts, tools/live.mjs and
# tools/smoke-origin.mjs keep working. Runs inside the worker image:
#   docker run --rm --entrypoint sh -v "$PWD/work:/app/work" -v "$PWD/spike:/spike:ro" \
#     mediacdn-pipeline:dev /spike/shaka-spike.sh <jobKey>
# Output: work/spike-shaka/ (copy it under origin/ to serve it).
set -eu
key=$1
in=/app/work/$key/mezzanine.mkv
out=/app/work/spike-shaka
tmp=/app/work/spike-tmp
rm -rf "$out" "$tmp"; mkdir -p "$out" "$tmp"

fps=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$in")
gop=$(awk -F/ -v f="$fps" 'BEGIN{split(f,a,"/"); printf "%d", (a[1]/a[2])*4}')
echo "fps=$fps gop=$gop"

# Rungs from the mezzanine. Keyframes every 4 s, no scene-cut keyframes, so segments split cleanly.
i=0
for h in 240 360 720; do
  case $h in 240) b=400 ;; 360) b=800 ;; 720) b=2800 ;; esac
  ffmpeg -hide_banner -loglevel error -y -i "$in" -map 0:v:0 -an \
    -vf "scale=-2:$h,setsar=1" -c:v libx264 -preset veryfast -profile:v high -b:v ${b}k -maxrate ${b}k -bufsize $((b * 2))k \
    -g "$gop" -keyint_min "$gop" -sc_threshold 0 -movflags +faststart "$tmp/v$i.mp4"
  i=$((i + 1))
done
ffmpeg -hide_banner -loglevel error -y -i "$in" -map 0:a:0 -vn -c:a aac -b:a 128k "$tmp/a.mp4"

packager \
  "in=$tmp/v0.mp4,stream=video,init_segment=$out/init-0.m4s,segment_template=$out/chunk-0-\$Number%05d\$.m4s,playlist_name=media_0.m3u8" \
  "in=$tmp/v1.mp4,stream=video,init_segment=$out/init-1.m4s,segment_template=$out/chunk-1-\$Number%05d\$.m4s,playlist_name=media_1.m3u8" \
  "in=$tmp/v2.mp4,stream=video,init_segment=$out/init-2.m4s,segment_template=$out/chunk-2-\$Number%05d\$.m4s,playlist_name=media_2.m3u8" \
  "in=$tmp/a.mp4,stream=audio,init_segment=$out/init-3.m4s,segment_template=$out/chunk-3-\$Number%05d\$.m4s,playlist_name=media_3.m3u8,lang=en,hls_group_id=audio,hls_name=main" \
  --segment_duration 4 --generate_static_live_mpd --default_language en \
  --hls_master_playlist_output "$out/master.m3u8" --hls_playlist_type VOD \
  --mpd_output "$out/manifest.mpd"

ls "$out" | head -40
