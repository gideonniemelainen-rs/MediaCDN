# Open video sources

Researched 2026-11-12 by reading the pages only (no files downloaded, no response headers inspected). Everything marked "unverified" is closed by `scripts/probe-sources.mjs` (run it and paste the output below).

## Summary
| Source | What it is | Browser-playable as-is? | License |
|---|---|---|---|
| [download.blender.org/demo/movies](https://download.blender.org/demo/movies/) | Progressive MKV/AVI/MOV/MPG and zipped MP4s (BBB 1080p/2160p zips, Sintel 1080p MKV ~1.17 GB, Elephants Dream teaser zip) | Mostly no | Big Buck Bunny: CC BY 3.0 (peach.blender.org/about). Others not confirmed on the pages read |
| [thestudio.io/osvideo](https://www.thestudio.io/osvideo/) | Catalog of 20 films linking to other hosts (video.blender.org MP4s, Wikimedia WebM, archive.org, jsDelivr for the Studio's own clips) | Yes (MP4/WebM progressive) | Per title, mostly CC BY 3.0; the Studio's own clips CC BY 4.0. The site hosts none of the third-party video |
| [opencontent.netflix.com](https://opencontent.netflix.com/) | Mastering-grade assets (IMF, EXR, ProRes, image sequences); few MP4s (Meridian UHD HDR, Cosmos Laundromat 2K HDR). Bucket `download.opencontent.netflix.com`, anonymous reads | Mostly no (HDR/mezzanine) | CC BY 4.0 |

None of them provides HLS or DASH, so adaptive streaming needs our own packaging step.

## Candidate titles (from thestudio.io, sizes and lengths as stated there)
| Title | Length | Format / size | License (as claimed) |
|---|---|---|---|
| Caminandes 3: Llamigos | 2:30 | 1080p MP4, 51 MB | CC BY 3.0 |
| Agent 327 | 3:51 | 1080p MP4, 45 MB | CC BY 3.0 |
| Coffee Run | 3:04 | 720p MP4, 39 MB | CC BY 3.0 |
| Big Buck Bunny | 9:56 | 720p MP4, 111 MB | CC BY 3.0 |
| Sprite Fright | 10:30 | 720p MP4, 102 MB | CC BY 3.0 |
| Sintel | 14:48 | 720p MP4, 200 MB | CC BY 3.0 |

Hosts: `video.blender.org/download/web-videos/<id>-<height>.mp4` (IDs on the osvideo page), Wikimedia, archive.org. The osvideo page says its link check was done 2026-10-25; liveness is unverified here.

## Licensing and attribution
- CC BY: show title, author, license and source link in the UI (credits footer) for every stream.
- Re-hosting in our own bucket is allowed by CC BY with attribution, but confirm each title's license on its original source before mirroring; the osvideo page's license claims are secondary.
- Biscuit / Studio Open clips (CC BY 4.0) have an extra "do not resell raw files as a stock library" clause.
- No hotlink or bandwidth policy was found for any of the hosts. Keep test traffic small; prefer our own copies for repeated use.

## Probe results (2026-11-12, `Origin: http://localhost:5173`)
| URL | Result | Range | CORS |
|---|---|---|---|
| video.blender.org web-videos (5 titles) | 206, `video/mp4`, sizes match the osvideo page (39 to 111 MB) | yes | `*` (after redirect) |
| download.blender.org `seamcut_blender242.mov` | 206, `video/quicktime`, 3.8 MB | yes | none |
| download.blender.org `elephantsdream-720-h264-st-aac.mov` | 206, `video/quicktime`, 152 MB | yes | none |
| upload.wikimedia.org Caminandes Llama Drama 1080p VP9 WebM | 206, `video/webm`, 16 MB | yes | `*` |
| download.opencontent.netflix.com.s3.amazonaws.com (virtual-hosted URL) | TLS error `ERR_TLS_CERT_ALTNAME_INVALID` | n/a | n/a |

What this means:
- **video.blender.org redirects.** Every `/download/web-videos/<id>-<h>.mp4` answers with a redirect to a presigned S3 URL under `/object-storage/web_videos/...` (24 h expiry, `response-content-disposition=attachment`). Browsers follow it fine and CORS is `*` on the final response, so direct playback works. For Media CDN this is the thing to design for: the origin must be allowed to follow redirects (`originRedirect` on the `EdgeCacheOrigin`), and the cached object is keyed on our request URL, not the presigned one.
- **download.blender.org sends no CORS headers.** A `<video src>` (what Shaka uses for progressive files) plays without CORS, but fetch/MSE-based playback (HLS/DASH through Shaka's networking engine) would be blocked. Fine for progressive; fronting it with Media CDN adds the CORS headers.
- **The Netflix failure is our URL, not the bucket.** The bucket name contains dots, so the virtual-hosted URL cannot match the `*.s3.amazonaws.com` wildcard certificate. Use the path-style form `https://s3.amazonaws.com/download.opencontent.netflix.com/...` (probe updated). Anonymous read access is still untested.
- **Progressive files and telemetry.** Shaka plays progressive files through the video element's `src`, so (to be confirmed in the browser) its networking filter, and with it per-request latency and CDN response headers, will not see those requests. Time to first frame, buffering and playback stats still work. Per-request telemetry and cache-status headers need HLS/DASH, which is another reason for the packaging step.

## Still unverified
- Codecs inside the files (`ffprobe` once installed).
- Anonymous listing and read of the Netflix bucket (retest with the path-style URL).
- Whether Media CDN follows the video.blender.org redirect as needed.
- Whether the Studio / video.blender.org hosts tolerate Media CDN cache-fill traffic (no policy published).
