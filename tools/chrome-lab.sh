#!/usr/bin/env bash
# Launches Chrome with a throwaway profile for the transport lab (infra/local/Caddyfile):
#   - h3 is forced on localhost:8443, so it does not depend on Chrome first seeing Alt-Svc;
#   - the lab certificate is trusted for this profile only (tools/lab-certs.sh writes its SPKI hash);
#   - a fresh profile every run, so Chrome's remembered Alt-Svc and QUIC state cannot leak between runs.
# Usage: bash tools/chrome-lab.sh [url]   (default http://localhost:5173/)
# Env: CHROME to override the binary.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
spki_file="$root/infra/local/localhost.spki"
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}

[ -x "$chrome" ] || { echo "Chrome not found at $chrome (set CHROME)" >&2; exit 1; }
[ -f "$spki_file" ] || { echo "no lab certificate: run bash tools/lab-certs.sh first" >&2; exit 1; }

profile=$(mktemp -d "${TMPDIR:-/tmp}/chrome-lab.XXXXXX")
trap 'rm -rf "$profile"' EXIT

"$chrome" \
  --user-data-dir="$profile" \
  --no-first-run --no-default-browser-check \
  --origin-to-force-quic-on=localhost:8443 \
  --ignore-certificate-errors-spki-list="$(cat "$spki_file")" \
  "${1:-http://localhost:5173/}"
