#!/usr/bin/env bash
# Adds latency and packet loss to the transport lab's ports (8441-8443) on macOS, with dummynet (dnctl) and pf.
# Without shaping, loopback has no RTT or loss, and h3 usually does not beat h2.
# Needs root, so run it by hand:
#   sudo bash tools/shape.sh on [rtt_ms] [loss_pct]    (defaults 80 ms, 1 %)
#   sudo bash tools/shape.sh off
# Delay is applied in each direction, so the round trip is the rtt you give. Loss is applied in each
# direction too, so the loss a packet sees round trip is a little higher than the figure.
# Untested on a machine where pf is already in use: `off` puts /etc/pf.conf back and releases the pf token.
set -euo pipefail

anchor=mediacdn-lab
token_file=/tmp/mediacdn-lab.pf-token
ports="8441, 8442, 8443"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

case "${1:-}" in
  on)
    rtt=${2:-80}
    loss=${3:-1}
    delay=$((rtt / 2))
    plr=$(awk -v p="$loss" 'BEGIN { printf "%.4f", p / 100 }')
    dnctl pipe 1 config delay "${delay}ms" plr "$plr"
    rules=$(mktemp)
    cat > "$rules" <<EOF
dummynet in quick proto { tcp, udp } from any to any port { $ports } pipe 1
dummynet in quick proto { tcp, udp } from any port { $ports } to any pipe 1
EOF
    # The anchors must be referenced from the main ruleset before pf will read them.
    { cat /etc/pf.conf; echo "dummynet-anchor \"$anchor\""; echo "anchor \"$anchor\""; } | pfctl -q -f -
    pfctl -q -a "$anchor" -f "$rules"
    rm -f "$rules"
    pfctl -E 2>&1 | sed -n 's/^Token : //p' > "$token_file" || true
    echo "shaping ports $ports: rtt ${rtt} ms, loss ${loss} % each way"
    ;;
  off)
    pfctl -q -a "$anchor" -F all 2>/dev/null || true
    dnctl -q flush
    pfctl -q -f /etc/pf.conf 2>/dev/null || true
    if [ -s "$token_file" ]; then pfctl -q -X "$(cat "$token_file")" 2>/dev/null || true; rm -f "$token_file"; fi
    echo "shaping removed"
    ;;
  *)
    echo "usage: sudo bash tools/shape.sh on [rtt_ms] [loss_pct] | off" >&2
    exit 1
    ;;
esac
