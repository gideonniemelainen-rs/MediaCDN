#!/usr/bin/env bash
# Adds latency and packet loss to the transport lab's ports (8441-8443) on macOS, with dummynet (dnctl) and pf.
# Without shaping, loopback has no RTT or loss, and h3 usually does not beat h2.
# Needs root, so run it by hand:
#   sudo bash tools/shape.sh on [rtt_ms] [loss_pct] [lo0_mtu]    (defaults 80 ms, 1 %, MTU unchanged)
#   sudo bash tools/shape.sh off
#   sudo bash tools/shape.sh status    (pipes and rules still in place)
# Delay is applied in each direction, so the round trip is the rtt you give. Loss is applied in each
# direction too, so the loss a packet sees round trip is a little higher than the figure.
# Loss is per packet, and loopback packets are large (TCP can send about 16 KB at a time, QUIC about 1.2 KB), so
# a loss figure punishes QUIC far more than TCP there. Passing lo0_mtu (1500 is what a real link has) makes the
# packets comparable; `off` puts the previous MTU back.
# Untested on a machine where pf is already in use: `off` puts /etc/pf.conf back and releases the pf token.
set -euo pipefail

anchor=mediacdn-lab
token_file=/tmp/mediacdn-lab.pf-token
mtu_file=/tmp/mediacdn-lab.lo0-mtu
ports="8441, 8442, 8443"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

case "${1:-}" in
  on)
    rtt=${2:-80}
    loss=${3:-1}
    mtu=${4:-}
    delay=$((rtt / 2))
    if [ -n "$mtu" ]; then
      [ -f "$mtu_file" ] || ifconfig lo0 | sed -n '1s/.*mtu \([0-9]*\).*/\1/p' > "$mtu_file"
      ifconfig lo0 mtu "$mtu"
    fi
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
    echo "shaping ports $ports: rtt ${rtt} ms, loss ${loss} % each way${mtu:+, lo0 mtu $mtu}"
    ;;
  off)
    # Each step reports its own failure: a silent failure here leaves the machine's loopback shaped.
    step() { echo "+ $*"; "$@" || echo "  (failed: $*)" >&2; }
    step pfctl -a "$anchor" -F all
    step dnctl -q flush
    step pfctl -q -f /etc/pf.conf
    if [ -s "$token_file" ]; then step pfctl -q -X "$(cat "$token_file")"; rm -f "$token_file"; fi
    if [ -s "$mtu_file" ]; then step ifconfig lo0 mtu "$(cat "$mtu_file")"; rm -f "$mtu_file"; fi
    echo "--- what is left (both should be empty):"
    dnctl list
    pfctl -a "$anchor" -s rules 2>&1
    ;;
  status)
    echo "--- dummynet pipes:"
    dnctl list
    echo "--- rules in anchor $anchor:"
    pfctl -a "$anchor" -s rules 2>&1
    echo "--- loopback:"
    ifconfig lo0 | sed -n 1p
    echo "--- pf:"
    pfctl -s info 2>&1 | sed -n '1,2p'
    ;;
  *)
    echo "usage: sudo bash tools/shape.sh on [rtt_ms] [loss_pct] [lo0_mtu] | off | status" >&2
    exit 1
    ;;
esac
