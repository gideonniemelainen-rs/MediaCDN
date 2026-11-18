#!/usr/bin/env bash
# Upload a packaged title from origin/<slug>/ to s3://$S3_BUCKET/media/<slug>/ with explicit
# Content-Type and Cache-Control (the AWS CLI guesses .m3u8/.m4s types unreliably).
# Dry run unless --go is given. Segments go first and manifests last, so a manifest never
# references objects that are not there yet. No --delete: the uploader policy has no DeleteObject.
#
# Usage: S3_BUCKET=<bucket> scripts/upload-s3.sh <slug> [--go]
#   AWS_PROFILE defaults to mediacdn-uploader; MANIFEST_CACHE overrides the manifest Cache-Control.
set -euo pipefail

slug=${1:?usage: S3_BUCKET=<bucket> $0 <slug> [--go]}
go=${2:-}
: "${S3_BUCKET:?set S3_BUCKET}"
export AWS_PROFILE=${AWS_PROFILE:-mediacdn-uploader}
[[ $slug =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "bad slug: $slug" >&2; exit 2; }

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/origin/$slug"
dest="s3://$S3_BUCKET/media/$slug"
[[ -d $src ]] || { echo "no such directory: $src" >&2; exit 2; }

dry=(--dryrun)
[[ $go == --go ]] && dry=()
manifest_cache=${MANIFEST_CACHE:-public, max-age=60}
immutable='public, max-age=31536000, immutable'

echo "profile=$AWS_PROFILE  $src -> $dest  ${dry[*]:-(uploading)}"
du -sh "$src" | awk '{print "size: " $1}'

# 1. Media segments and init files (immutable: names never change content).
aws s3 sync "$src" "$dest" "${dry[@]}" \
  --exclude '*' --include '*.m4s' \
  --content-type video/mp4 --cache-control "$immutable"

# 2. Manifests last.
aws s3 sync "$src" "$dest" "${dry[@]}" \
  --exclude '*' --include '*.m3u8' \
  --content-type application/vnd.apple.mpegurl --cache-control "$manifest_cache"
aws s3 sync "$src" "$dest" "${dry[@]}" \
  --exclude '*' --include '*.mpd' \
  --content-type application/dash+xml --cache-control "$manifest_cache"
