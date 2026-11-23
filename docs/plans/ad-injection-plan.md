# Ad injection variants in the 4-box player (CSAI, SSAI, SGAI)

Status: planned, not started. Resumes after the telemetry and packaging build (see `docs/sources.md`). Step 0 is half done (checked 2026-11-23): the ad assets no longer depend on third-party URLs (`scripts/make-ads.mjs` builds `origin/ads/` with an `ads.json` inventory that `web/src/ads.ts` reads), but whether the overlay plays has not been established. "Trigger ad" with a single quadrant playing showed nothing, and the cause was not diagnosed. `ad-service/` is still empty.

## Context
The client (`web/`) plays four Shaka quadrants with focus-based audio, plus a basic ad overlay (`web/src/AdOverlay.tsx`, `ads.ts`, ad state in `state.ts`). That overlay currently does not work. The goal is learning: implement one or more versions of each ad-injection model behind a common switch and compare them side by side.

Third type = **server-guided ad insertion (SGAI)**: HLS Interstitials (and, as a stretch, DASH events / Alternative MPD).

| Model | Who decides the ad | Who stitches it in | Fetch + playback | Tracking |
|---|---|---|---|---|
| CSAI | Server (VAST) | Client | Separate ad player/element | Client beacons |
| SSAI | Server | Server rewrites the manifest | Same stream; player sees one timeline | Server watches ad segment requests |
| SGAI | Server | Client, told by the manifest | Player fetches ad assets listed by the server | Client events |

## Decisions
- SSAI: a small DIY stitcher service (Node/TS). Google's Video Stitcher API appears to need account-rep/sales enablement, so it is out for the free tier; optional later swap.
- CSAI: own VAST XML from the ad service, parsed in the client. IMA SDK with Google sample tags is optional later.
- SGAI: HLS Interstitials first; DASH is a stretch (spec support is less settled).

## Step 0: fix the current ads
1. Find out why ads fail (devtools console/network). Suspects: the third-party sample MP4 URLs are dead/blocked/lack CORS; autoplay behavior. Not yet diagnosed.
2. Stop depending on third-party URLs: generate our own ad assets (ffmpeg `lavfi testsrc2` with drawtext "AD 1/2/3" and a tone; MP4 plus HLS with 2 renditions matching the content codecs) and serve them from the ad service.
3. GCP free tier only when needed: ad assets need just a Cloud Storage bucket (check current always-free limits) and optionally Cloud Run for the ad service. Media CDN is not needed for ads at first.

## Shared structure
```
ad-service/            Node + TypeScript, local :8787, Cloud Run later
  src/vast.ts          GET /vast/:adId.xml, /vast/pod.xml -> VAST 4
  src/track.ts         /track: logs impressions/quartiles/errors, /track/log for the UI
  src/stitch/          SSAI stitcher
  src/sgai/            SGAI playlist proxy + asset-list endpoints
  public/ads/          generated ad assets
web/src/ads/
  types.ts             AdMode = 'off' | 'csai-overlay' | 'csai-instream' | 'ssai' | 'sgai'
  csai.ts, vast.ts     fetch + parse VAST, fire trackers
  strategy.ts          picks stream URL + wiring per mode
```
- Global **Ad mode** dropdown; the catalog URL resolver takes the mode so SSAI/SGAI streams come from the ad service.
- A tracking-log panel (events per variant), ideally feeding the telemetry store.
- Vite dev proxy `/api` to `localhost:8787`.
- Reuse `AdOverlay` and `pickAdSlot` / `canHostAd` / `isStreamMuted` in `web/src/state.ts` for the "ad in an unfocused quadrant" behavior.

## Variants

### A. Client-side (CSAI)
- **A1 `csai-overlay`:** overlay in an unfocused quadrant, driven by VAST. This is the project's own twist, not how real players do it.
- **A2 `csai-instream`:** classic: pause content in the same quadrant, play the ad, resume at the same position; mid-roll at a configured time for VOD, wall-clock for live (shows why CSAI struggles with live).
- Shared `vast.ts`: fetch, parse with `DOMParser`, choose `MediaFile`, fire `Impression`, `Start`, `FirstQuartile`, `Midpoint`, `ThirdQuartile`, `Complete`, `Error`. Check Shaka's ad manager docs first for built-in VAST support.
- Learning: ad blockers see `/track` and the VAST call; the client has full measurement; ads are a separate timeline.

### B. Server-side (SSAI), DIY stitcher
- `GET /api/ssai/session?stream=<id>` creates a session (id, break schedule); one per quadrant.
- `.../master.m3u8` rewrites variant URIs to stitcher URLs; `.../:variant.m3u8` makes segment URIs absolute and splices the ad's segments from the matching rendition with `#EXT-X-DISCONTINUITY` before and after.
- VOD first (deterministic), live second (sliding window re-stitched on each poll, session break state, nearest-bandwidth ad rendition).
- Only playlists are proxied; segments come straight from origin/CDN. Ad impressions via a thin logging redirect for ad segments.
- HLS content only.
- Learning: the player cannot tell ads from content (blockers can't see them); per-viewer manifests are not CDN-cacheable but segments are; the ad lands in the same quadrant, so it is audible if that quadrant is focused.

### C. Server-guided (SGAI), HLS Interstitials
- `GET /api/sgai/:stream/playlist.m3u8` proxies the content playlist and adds `#EXT-X-DATERANGE` with `CLASS="com.apple.hls.interstitial"`, `START-DATE`, `X-ASSET-LIST="/api/sgai/asset-list/<break>"` (or `X-ASSET-URI`), plus `X-RESUME-OFFSET`. Needs `#EXT-X-PROGRAM-DATE-TIME`; inject if missing.
- `GET /api/sgai/asset-list/:break` returns `{"ASSETS":[{"URI":"<ad>.m3u8","DURATION":15}]}`, chosen at request time.
- Client: Shaka's built-in interstitial handling plays the break; listen to its events for tracking. Confirm in the installed Shaka version (5.3.x) that interstitials are enabled and how to subscribe; read the shipped docs/types in `web/node_modules/shaka-player` first (search results were secondhand).
- Stretch: DASH MPD event / Alternative MPD signal.
- Learning: server decides, client plays and measures; non-supporting players ignore the tags; ad assets are separate cacheable HLS streams.

## Milestones
0. Diagnose/fix the overlay; generated ad assets and static hosting (local).
1. `ad-service` skeleton, VAST endpoints, `/track`, Vite proxy, Ad mode dropdown, tracking panel.
2. CSAI: A1 on VAST, then A2 in-stream with mid-roll.
3. SGAI on a VOD HLS stream, then on the live simulation.
4. SSAI stitcher for VOD, then live.
5. `docs/ad-injection.md`: comparison filled with observations (who saw what, ad-blocker behavior, cacheability, tracking).
6. Later: ad assets/service on a free-tier GCP project behind Media CDN (`/ads/*` and segments cached; stitched/SGAI manifests short-TTL or bypass).

## Risks
- gcloud and Terraform are not installed (ffmpeg is).
- Cause of the current ad failure unknown: the third-party URL suspect is gone, so it is now something in the overlay, the ad state or the inventory fetch.
- SSAI live stitching is the hardest part (sliding window, discontinuities, codec mismatch).
- Video Stitcher API availability requires sales enablement.

## Verification
- Vitest: VAST parsing and tracker selection, break-point calculation, reducer; stitcher golden-file tests on fixture playlists; SGAI DATERANGE and asset-list tests.
- Manual per variant: select mode, trigger/wait for the break; the ad plays, content resumes, the tracking log shows expected events, audio follows focus rules.
- Block `/api/track` and `/api/vast` in devtools: CSAI loses the ad or tracking, SSAI still plays ads, SGAI plays ads but may lose beacons.
