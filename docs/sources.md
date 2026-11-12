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

## Unverified (to be closed by the probe)
- URL liveness, `Accept-Ranges`/206 support, `Access-Control-Allow-Origin`
- Codecs inside the files
- Whether `download.opencontent.netflix.com` allows anonymous listing (the browse URL returned a TLS hostname error); contents of `TechblogAssets/CosmosLaundromat/encodes/`
- Whether Media CDN follows redirects (archive.org) as needed

## Probe results
_Paste the output of `node scripts/probe-sources.mjs` here._
