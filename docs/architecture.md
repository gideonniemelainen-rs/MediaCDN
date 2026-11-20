# Architecture

Browser (React SPA) -> 4x Shaka players -> Media CDN (EdgeCacheService) -> EdgeCacheOrigin(s) -> external public test streams.
Ads: client calls `GET /api/ad` (Cloud Run) and plays the returned clip, served via the `/ads/*` Media CDN route, in a non-focused quadrant.

Ingest: uploads go through `pipeline/` (probe, validate, normalise, then ladder, encode and CMAF packaging in later milestones) before landing on an origin. The `/upload/` page drives that locally and shows each stage as a workflow graph. See `plans/transcoding-pipeline.md` and `plans/upload-page.md`.

Decisions: React + Vite + TS, Shaka Player (HLS + DASH), external origins, own ad clips + simple ad API, Terraform.
