# mediaCDN

PoC: a 4-quadrant video streamer on Google Cloud Media CDN. Each quadrant plays a user-selected VOD or live stream; only the focused quadrant has audio, and video ads can play in an unfocused quadrant.

See `docs/` for architecture and decisions.

## Layout
- `infra/` Terraform for Media CDN origins, routes, keyset, and Cloud Run
- `web/` React + Vite + TypeScript client (Shaka Player)
- `ad-service/` ad-decision API (Cloud Run)
- `catalog/` selectable stream list
