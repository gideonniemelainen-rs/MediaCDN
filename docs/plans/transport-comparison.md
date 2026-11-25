# Transport comparison: HTTP/1.1 vs HTTP/2 vs HTTP/3 (QUIC)

Status: milestone 1 (capture the negotiated transport) built and browser-checked 2026-11-24; milestone 2 (local lab) written 2026-11-25: Caddyfile validates and TLS negotiation was checked for h1 and h2 (8441 answers only `http/1.1`, 8442 and 8443 answer `h2` when offered), and h3 was confirmed in Chrome through `tools/chrome-lab.sh` (2026-11-25: Resource Timing reported `http/1.1` for :8441, `h2` for :8442 and `h3` for :8443, and Caddy listens on UDP 8443). `tools/shape.sh` has not been run; milestone 3 (live comparison) built 2026-11-25, not yet checked in the lab window: a per-quadrant transport picker for the local origin (`VITE_LOCAL_BASE_H1/H2/H3`, a "compare transports" preset), the observed protocol, mean first-byte and connect time in the summary, a `proto` line in the stats overlay, a `proto` column and a by-transport table in the telemetry panel, and a `transport` column in the CSV. Differences from the plan below: an unconfigured listener says which variable to set instead of falling back to `VITE_LOCAL_BASE`, and the requested transport is not stored on every event (the request URL shows the port, and saved runs keep the observed protocol in each request's data). Milestone 4 not started. In the browser, all 17 local requests were recorded as `h1` with connect and first-byte times, and all 17 S3 near requests as `unknown` with null timings, because the bucket sends no `Timing-Allow-Origin`. The Resource Timing join worked with the retry schedule (0, 50, 150, 400 ms); no local request stayed `unknown`. Not yet tried: h2 or h3 (needs the Caddy lab), and range requests sharing a URL under load (covered only by unit tests).

Goal: record which HTTP version each request actually used, and compare h1, h2 and h3 live in the four-quadrant player and in the telemetry export.

## Context

The app records per-request and per-session telemetry (startup, rebuffer, segment latency and throughput, ABR switches), grouped by `delivery` (`direct`, `local`, `s3-near`, `s3-far`, `cdn-public`, `cdn-s3`). Nothing records the transport protocol.

What the code and Shaka Player 5.3.3 allow today:

- Shaka fetches through the browser (`HttpFetchPlugin`, XHR fallback) and its `Response` has no protocol field. The only browser source for the negotiated protocol is Resource Timing `nextHopProtocol` (`h2`, `h3`, `http/1.1`).
- Cross-origin, `nextHopProtocol` and most timings are blank unless the response carries `Timing-Allow-Origin`. That header exists nowhere in the repo. `tools/serve-origin.mjs:25-29` also exposes none of the diagnostic headers `KEEP_HEADER` looks for (`web/src/telemetry/shaka.ts:15`).
- A page cannot force a protocol. It can only pick an origin that offers one, so comparison means serving the same content from separate origins that each allow a single protocol.
- The local origin is cleartext HTTP/1.1 on `node:http` (port 8788), with no TLS or cert setup and no Node HTTP/3 server. `infra/` is empty and `VITE_CDN_BASE` is unset, so there is no Media CDN yet.
- `Protocol` in `web/src/catalog.ts` already means hls/dash/progressive, so the new concept is named **transport**.
- `delivery` was one global state, so quadrants could not differ. As of 2026-11-20 each quadrant has its own delivery (`PlayerState.deliveries` in `web/src/state.ts`), and the telemetry already records it per event. A per-slot transport choice can sit beside it.

## Decisions

- Build the capture and comparison layer plus a **local lab first** (Caddy with h1, h2 and h3 listeners in front of the existing origin), then point the same layer at Media CDN once `infra/` exists.
- Present the comparison **live side by side**, with per-request protocol in the JSON/CSV export.
- Target Chromium only for forced-protocol runs. Safari and Firefox report `nextHopProtocol` differently and cannot be forced the same way.

## Milestone 1: capture the negotiated transport

Works against any target.

- New pure module `web/src/telemetry/transport.ts`:
  - `normaliseTransport(nextHopProtocol)` returns `'h1' | 'h2' | 'h3' | 'unknown'`.
  - `pickTiming(entries, response)` joins on `response.uri`, choosing the entry whose `responseEnd` is nearest the request time, because range requests share a name.
  - Returns `{ transport, connectMs, ttfbMs }`.
- `web/src/telemetry/shaka.ts`:
  - Call `performance.setResourceTimingBufferSize` (the default of 250 entries is too small).
  - In the response filter, add `transport`, `connectMs` and `ttfbMs` to the `request` event's `data`.
  - Use a PerformanceObserver cache so entries that land after the filter fires still resolve, falling back to `unknown`.
  - Add `alt-svc` to `KEEP_HEADER`.
  - Add the requested transport to `Ctx` and to `recordAbrCap` in `QuadrantPlayer.tsx`.
- `tools/serve-origin.mjs`: add `Timing-Allow-Origin: *` and extend `Access-Control-Expose-Headers` with `Alt-Svc, Age, X-Cache, Via, Cache-Control, Server`. Assert both in `tools/smoke-origin.mjs`.
- The CORS settings of both S3 buckets (near and far) and the Media CDN route response headers need the same headers. None of them is in the repo. (Reading `index.json` from the near bucket already returns HTTP 403, so its policy needs attention first.)

## Milestone 2: local multi-protocol lab

- `infra/local/Caddyfile` and `infra/local/README.md`. Caddy reverse-proxies the existing `node tools/serve-origin.mjs`, so ranges, MIME types and the `/live` simulator are reused.

| Port | Protocols |
| --- | --- |
| 8441 | h1 only |
| 8442 | h1 + h2 |
| 8443 | h1 + h2 + h3, with `Alt-Svc` |

- TLS comes from mkcert (`localhost`). The exact per-listener `protocols` syntax must be checked against the installed Caddy version.
- `tools/chrome-lab.sh`: launches Chrome with a throwaway profile and `--origin-to-force-quic-on=localhost:8443`, so h3 does not depend on first seeing `Alt-Svc`. Without the flag, Chrome's first request goes over h2.
- `tools/shape.sh`: adds latency and loss to the three ports on macOS (dummynet via `dnctl`/`pfctl`). It needs `sudo`, so it is run by hand. Without shaping, loopback has no loss or RTT and h3 usually does not beat h2, so the comparison is only meaningful with shaping.
- `web/src/catalog.ts` `BASES`: add `VITE_LOCAL_BASE_H1`, `_H2`, `_H3`, falling back to `VITE_LOCAL_BASE`. Add them to the pinned test env in `web/vite.config.ts`.

## Milestone 3: live side-by-side comparison

- `catalog.ts`: `type Transport = 'h1' | 'h2' | 'h3'` (the one requested) and `resolveStream(stream, delivery, transport?)` picks the local base. For `cdn-*` and `s3-*` the transport is whatever the server negotiates.
- Per-slot transport selection beside the per-quadrant Delivery picker in `App.tsx`, passed to `QuadrantPlayer`. It goes into the effect deps because the URL changes, and into `ctx`.
- `telemetry/types.ts`: add `transport` to `TelemetryEvent` as a first-class field, like `delivery`.
- `telemetry/metrics.ts`:
  - `Summary` gains the dominant observed `transport` and mean `connectMs`.
  - New `summarizeByTransport(events)` groups startup, rebuffer, segment latency and throughput by delivery and observed transport.
- UI:
  - `StatsOverlay.tsx`: a `proto h3` line beside `segs`.
  - `TelemetryPanel.tsx`: a transport column (update the idle row's `colSpan`) and a comparison table.
- Export: add a `transport` column to `toCSV` and update the exact-string test in `metrics.test.ts`. The JSON export carries per-request `transport`, `connectMs` and `ttfbMs` automatically.
- Showing the observed protocol per quadrant also catches silent fallback, such as Chrome dropping from h3 to h2 when UDP is blocked.

## Milestone 4: Media CDN

Later, when `infra/` exists. No Terraform now.

- Set `VITE_CDN_BASE` and add `Timing-Allow-Origin` and `Alt-Svc`-related headers on the route.
- Check Media CDN's docs for whether QUIC can be disabled per service, to force an h2 baseline.
- Reuse the capture and comparison layer unchanged.

## Out of scope

- `tools/bench.mjs` uses Node's fetch (h1), so protocol benchmarking there is separate.
- Server push and QUIC tuning.

## Files

New:
- `web/src/telemetry/transport.ts` and its test
- `infra/local/Caddyfile`, `infra/local/README.md`
- `tools/chrome-lab.sh`, `tools/shape.sh`
- `docs/transport-comparison.md` (how-to, written once built)

Modified:
- `web/src/telemetry/{shaka,types,metrics}.ts` and `metrics.test.ts`
- `web/src/{catalog,App,QuadrantPlayer,StatsOverlay,TelemetryPanel}.tsx|ts`
- `web/vite.config.ts`, `tools/serve-origin.mjs`, `tools/smoke-origin.mjs`
- `README.md`, `docs/architecture.md`

## Verification

1. `cd web && npm test`: new pure tests for `normaliseTransport`, `pickTiming` (including range-request collisions) and `summarizeByTransport`, plus the updated CSV test.
2. `node tools/smoke-origin.mjs <id>` confirms `Timing-Allow-Origin` and the exposed headers.
3. Start the origin, Caddy and `tools/chrome-lab.sh`, then load one title in three quadrants on h1, h2 and h3. The stats overlay and export must show `h1`, `h2` and `h3` respectively. Confirm independently with Chrome DevTools' Protocol column, or `curl --http3-only` if curl supports it.
4. Run with and without `tools/shape.sh` and compare the per-transport table.

## Risks

- **Resource Timing join is the main unknown.** Entries may arrive after the response filter fires, so a short spike comes first.
- **Alt-Svc caching.** Chrome remembers h3 state between runs, which the throwaway profile avoids.
- **Safari and Firefox** are out of the forced-protocol runs (see Decisions).
- **S3 (near and far) and Media CDN** report `unknown` until `Timing-Allow-Origin` is configured outside this repo.
- **Shaping needs `sudo`**, so it is run by hand.
