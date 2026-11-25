#!/usr/bin/env bash
# Makes the certificate the transport lab (infra/local/Caddyfile) serves, with mkcert, and prints the
# SPKI hash tools/chrome-lab.sh trusts. Does not run `mkcert -install`, so nothing is added to your
# system trust store: chrome-lab.sh trusts this one certificate for its throwaway profile only.
# Usage: bash tools/lab-certs.sh
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
dir="$root/infra/local"

command -v mkcert >/dev/null || { echo "mkcert is not installed: brew install mkcert" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

mkcert -cert-file "$dir/localhost.pem" -key-file "$dir/localhost-key.pem" localhost 127.0.0.1 ::1
spki=$(openssl x509 -in "$dir/localhost.pem" -pubkey -noout | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | openssl enc -base64)
echo "$spki" > "$dir/localhost.spki"
echo "wrote $dir/localhost.pem, localhost-key.pem and localhost.spki ($spki)"
