#!/usr/bin/env bash
# Starts everything the app needs for local development and stops it again on Ctrl-C:
#   db        Postgres (docker compose, pipeline/compose.yaml)      :5432
#   origin    packaged media + simulated live (tools/serve-origin)  :8788
#   pipeline  upload + auth API (pipeline/bin/serve.mjs)            :8790
#   web       Vite dev server                                       :5173
# A service whose port is already listening is left alone and reused, so it is safe to run twice.
# Usage: scripts/dev.sh [--stop-db] [--no-origin]
#   --stop-db    also stop the db container on exit (default: leave it running, its data is kept)
#   --no-origin  skip the media origin (e.g. you only use S3 or the CDN)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

stop_db=0
want_origin=1
for arg in "$@"; do
  case "$arg" in
    --stop-db) stop_db=1 ;;
    --no-origin) want_origin=0 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }
need() { command -v "$1" >/dev/null || { echo "$1 not found: $2" >&2; exit 1; }; }

need node "install Node 24 or newer"
need npm "install Node 24 or newer"
need docker "install Docker (or Rancher Desktop), the database runs in a container"
docker info >/dev/null 2>&1 || { echo "docker is installed but not running: start it and try again" >&2; exit 1; }

pids=()
names=()

cleanup() {
  trap - INT TERM EXIT
  echo
  local i
  for i in ${pids[@]+"${!pids[@]}"}; do
    kill "${pids[$i]}" 2>/dev/null && echo "stopped ${names[$i]}"
  done
  if [ "$stop_db" = 1 ]; then
    docker compose -f pipeline/compose.yaml stop db >/dev/null && echo "stopped db"
  fi
  exit 0
}
trap cleanup INT TERM EXIT

# Runs a command in the background with every output line prefixed by the service name.
start() {
  local name=$1 port=$2
  shift 2
  if listening "$port"; then
    echo "$name: already listening on :$port, reusing it"
    return
  fi
  "$@" > >(while IFS= read -r line; do printf '[%s] %s\n' "$name" "$line"; done) 2>&1 &
  pids+=("$!")
  names+=("$name")
}

# 1. Database. --wait blocks until the container's healthcheck passes, so the pipeline server can connect.
echo "db: starting Postgres"
docker compose -f pipeline/compose.yaml up -d --wait db >/dev/null

# 2. Dependencies, only when missing.
[ -d pipeline/node_modules ] || { echo "installing pipeline dependencies"; (cd pipeline && npm install --no-audit --no-fund >/dev/null); }
[ -d web/node_modules ] || { echo "installing web dependencies"; (cd web && npm install --no-audit --no-fund >/dev/null); }

# 3. Services. Vite is started from its own binary (not through npm) so that stopping it really stops it.
[ "$want_origin" = 1 ] && start origin 8788 node tools/serve-origin.mjs
start pipeline 8790 node pipeline/bin/serve.mjs
start web 5173 bash -c 'cd web && exec ./node_modules/.bin/vite'

echo
echo "  app        http://localhost:5173        (sign in as admin / admin on first run)"
echo "  upload     http://localhost:5173/upload/"
echo "  origin     http://localhost:8788"
echo "  pipeline   http://127.0.0.1:8790/api/pipeline/health"
echo "  Ctrl-C stops what this script started."
echo

# Run until a service dies (a startup failure, such as the pipeline server refusing to start, ends the script).
while :; do
  for i in ${pids[@]+"${!pids[@]}"}; do
    if ! kill -0 "${pids[$i]}" 2>/dev/null; then
      echo "${names[$i]} exited, stopping the rest" >&2
      exit 1
    fi
  done
  [ ${#pids[@]} -gt 0 ] || { echo "everything was already running, nothing to do"; exit 0; }
  sleep 1
done
