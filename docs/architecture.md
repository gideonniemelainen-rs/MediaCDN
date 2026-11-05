# Architecture

Browser (React SPA) -> 4x Shaka players -> Media CDN (EdgeCacheService) -> EdgeCacheOrigin(s) -> external public test streams.
Ads: client calls `GET /api/ad` (Cloud Run) and plays the returned clip, served via the `/ads/*` Media CDN route, in a non-focused quadrant.

Decisions: React + Vite + TS, Shaka Player (HLS + DASH), external origins, own ad clips + simple ad API, Terraform.
