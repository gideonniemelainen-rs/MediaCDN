# Delivery benchmark: S3 direct vs Media CDN

Not to be confused with the in-app comparison: playing one title in several quadrants and pressing Save run in the telemetry panel stores a live comparison in the database (see `plans/history-storage.md`). This CLI report is separate and is loaded from a file.

`tools/bench.mjs` fetches the same packaged title through several base URLs ("targets") and compares
latency, throughput and cache behaviour. It also projects a monthly cost for each path.

## Run it

```sh
node tools/serve-origin.mjs &                      # local origin on :8788
node tools/bench.mjs --target local=http://localhost:8788 --slug bbb --rounds 5
```

Once the cloud pieces exist, add them as further targets (any host serving the `origin/` layout):

```sh
node tools/bench.mjs \
  --target s3=https://<bucket>.s3.<region>.amazonaws.com/media \
  --target cdn=https://<edge-host>/s3 \
  --rounds 20
```

Then open the app, tick **benchmark** and load `bench/report.json`.

## What it measures
- Per request: time to first byte, total time, bytes, status, cache status (`x-cache`, `x-goog-cache-status`,
  `cf-cache-status`, else a positive `Age`).
- Per target: p50/p95/p99 TTFB, segment time, segment throughput, error count, hit ratio.
- Targets run in rotation each round (the first target changes every round) so drift and cold-cache
  ordering don't favour one path. Round 0 of a CDN target is the cold fill; later rounds are warm.
- All targets fetch the same objects: a middle ladder rung's first N segments, taken from the local `origin/`.

## Cost model
`bench/rates.json` holds every rate. **All figures are estimates**; Media CDN prices were not found, and
Cloud CDN list prices stand in for them. Edit the file, not the code. `monthlyCost()` in
`tools/bench-lib.mjs`:
- direct = S3 egress (after the free allowance) + GET requests + storage
- via CDN = CDN egress + cache fill + lookups + S3 egress and GETs for the miss share + storage

The hit ratio is the measured one when a target whose name contains `cdn` is benchmarked, otherwise 0.9.
A "view" is one benchmark round (2 manifests plus the sampled segments), not a full session, so treat the
scenario volumes as relative, not absolute.

## Limits
- One vantage point, one client: results mostly reflect a single edge location and S3 region.
- Sequential requests from one client show latency, not congestion or capacity.
- Until a CDN target exists, the report only compares local runs against themselves.
- Target names are free text and are not the app's `Delivery` ids (`local`, `s3-near`, `s3-far`, `cdn-s3`, ...). Importing a CLI report into the saved-runs store would need that mapping.
