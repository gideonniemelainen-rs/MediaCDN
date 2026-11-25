# Local transport lab

The local origin (`tools/serve-origin.mjs`, port 8788) behind Caddy on three TLS ports, each allowing different HTTP versions, so the same title can be compared over h1, h2 and h3. See `docs/plans/transport-comparison.md`.

| Port | Protocols |
| --- | --- |
| 8441 | h1 only |
| 8442 | h1 + h2 |
| 8443 | h1 + h2 + h3 (Caddy sends `Alt-Svc`) |

Caddy and mkcert run on the host (Homebrew), not in Docker: traffic shaping with `dnctl`/`pfctl` applies to host loopback, which a container behind Docker Desktop's VM would bypass, and mkcert has to run on the host anyway.

## Setup (once)

```
brew install caddy mkcert
bash tools/lab-certs.sh
```

`lab-certs.sh` writes `infra/local/localhost.pem`, `localhost-key.pem` and `localhost.spki` (all git-ignored). It does not run `mkcert -install`, so your system trust store is untouched; `tools/chrome-lab.sh` trusts that one certificate for its own throwaway profile.

## Run

```
bash scripts/dev.sh                                          # origin on :8788 and the app on :5173
caddy run --config infra/local/Caddyfile --adapter caddyfile  # from the repo root
bash tools/chrome-lab.sh                                      # Chrome with h3 forced on localhost:8443
```

`chrome-lab.sh` uses a fresh profile every run, so Chrome's remembered `Alt-Svc` and QUIC state cannot carry over. Without `--origin-to-force-quic-on`, the first request to :8443 would go over h2.

## Shaping (optional, needs sudo)

Loopback has no RTT or loss, so h3 usually does not beat h2 without shaping.

```
sudo bash tools/shape.sh on 80 1     # 80 ms round trip, 1 % loss each way
sudo bash tools/shape.sh off
```

## Checking which protocol answered

```
curl -sk --http1.1 -o /dev/null -w '%{http_version}\n' https://localhost:8441/index.json   # 1.1
curl -sk --http2   -o /dev/null -w '%{http_version}\n' https://localhost:8442/index.json   # 2
curl -sk --http3-only -o /dev/null -w '%{http_version}\n' https://localhost:8443/index.json # 3 (needs a curl built with HTTP/3)
```

In the app, the observed protocol is the `transport` field on each `request` event (milestone 1).
