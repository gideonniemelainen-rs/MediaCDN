# Step 3: Settings, the settings API and a runtime Delivery module

Status: planned 2026-11-25, not started. Third of six steps toward a GUI-driven tool; steps 1 and 2 are `shared-ladder.md` and `title-layout.md` (both built). Terms are in `CONTEXT.md`. This is the step the GUI toggles sit on: step 5's Settings page only edits what this step makes editable.

## Why

Everything a person would toggle is fixed at build or boot time, in different places:

| Knob | Where it lives today | When it is read |
| --- | --- | --- |
| Delivery base URLs (`local`, `s3-near`, `s3-far`, `cdn-*`, and `local` h1/h2/h3) | `VITE_*_BASE` in `web/.env.local`, read in `catalog.ts` | Vite build / dev-server start |
| Which deliveries exist, their labels, index prefix, env var name | five parallel tables in `catalog.ts`: `BASES`, `INDEX_PREFIX`, `BASE_VAR`, `DELIVERY_LABEL`, `TRANSPORT_BASES` / `TRANSPORT_VAR` | module load |
| Ads base | `VITE_ADS_BASE`, falling back to `VITE_LOCAL_BASE` (`ads.ts:13`) | module load |
| Uncapped switch | `useState(false)` in `App.tsx`, not persisted | per page load |
| Packager and worker image | `PIPELINE_PACKAGER`, `PIPELINE_IMAGE`, read once in `createSteps` (`steps.mjs:52-53`) | server start |
| Content-aware ladder CRF | `LADDER_CRF` constant in `shared/src/ladder.ts` | code |
| Simulated live window | `WINDOW = 5` in `tools/live.mjs` | code |

So changing any of them means editing a file and restarting something, and the Player cannot even show *why* a delivery is unavailable beyond "set VITE_…". The catalog module also mixes four concerns (static data, env config, a module-global index store with `indexes` / `statuses` / `inflight`, and stream derivation), which is why the tests pin the env through `vite.config.ts`.

Six real deliveries already vary across the seam (`direct`, `local`, `s3-near`, `s3-far`, `cdn-public`, `cdn-s3`), so a Delivery record is a deepening with many adapters, not a speculative seam.

## Decisions already made (from the design interview)

- **Scope:** config and workflows only; `scripts/dev.sh` still starts every service. Boot-time values (ports, `DATABASE_URL`, `PIPELINE_ALLOWED_ORIGINS`) stay in env and are shown read-only.
- **Store:** a Postgres table served by the pipeline API; writes are admin-only.
- **Player fallback:** the Player fetches `/settings` at load and falls back to built-in `VITE_*` defaults, with a "settings unavailable" notice, if it can't.
- **Origin:** re-fetches settings with a short cache and keeps its last-known values if the API is down.
- **Settings groups:** deliveries, packaging, player behaviour, origin and ops.
- **Shared code:** TypeScript in `shared/`, no build step.
- Commits go straight to `main`; tests green at each work item.

## Design

### Overrides, not a full document (recommended, to confirm)

The API stores and returns **overrides only**: the fields someone has explicitly set. Each client merges them over its own defaults: the web app over values built from `VITE_*`, the pipeline over `PIPELINE_PACKAGER` / `PIPELINE_IMAGE`, the origin over its constants. Consequences:

- A fresh database changes nothing: the Player behaves exactly as it does today until someone saves a setting.
- The "fall back to env defaults when the API is down" decision is the same code path as "nothing overridden", so there is one merge, not a merge plus a fallback.
- A setting with no override can be reset by deleting the key, which the GUI shows as "default".

### Shared contract: `shared/src/settings.ts` and `shared/src/deliveries.ts`

```
deliveries.ts   DELIVERIES (ids, picker order), and per delivery its static record:
                { id, label, baseVar, indexPrefix | null, indexed, transportable }
                (the five parallel tables in catalog.ts become this one table)
settings.ts     the schema, per group: field name, type, validator, default-source note
                  deliveries: per delivery { enabled, base } and local { baseH1, baseH2, baseH3 }
                  packaging:  { packager: 'ffmpeg'|'shaka', image, ladderCrf }
                  player:     { adsBase, adsEnabled, uncappedDefault }
                  origin:     { liveEnabled, liveWindow }
                validateGroup(group, value)  -> { ok, value } | { ok: false, errors }
                resolve(defaults, overrides) -> the effective settings
```

`validateGroup` is the interface both ends cross: the API rejects what it fails, and the GUI form (step 5) uses the same function for inline errors. It is pure, so the tests need no server or database.

### API (pipeline server, under `/api/pipeline`)

- `GET /settings` returns `{ revision, overrides }`. **Unauthenticated**, like `/health`, so the Player works signed out (this is the one decision I want you to confirm; it exposes base URLs and toggles, and nothing secret, since credentials are never stored in settings).
- `PUT /settings/:group` admin only; body is the group's overrides; validated with the shared schema; returns the new `{ revision, overrides }`. Sends `If-Match: <revision>`; a stale revision gets `409` so two browser tabs cannot silently overwrite each other.
- `DELETE /settings/:group/:field` admin only; resets one field to its default.

Storage: migration `002-settings.sql`, one row per group:

```sql
CREATE TABLE settings (
  group_name text PRIMARY KEY,
  value      jsonb NOT NULL,
  revision   bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users (id)
);
```

A single `revision` for `GET` is the max across rows, so the origin and Player can ask "has anything changed" cheaply.

### Runtime Delivery module (web)

`catalog.ts` splits in three, with the same exports kept at first so call sites don't change:

- `deliveries.ts`: the effective delivery table (`resolve(envDefaults, overrides)`), an `applySettings(overrides)` entry point and a subscription, replacing `BASES` / `INDEX_PREFIX` / `BASE_VAR` / `DELIVERY_LABEL` / `TRANSPORT_*`.
- `indexStore.ts`: the module-global `indexes`, `statuses`, `inflight`, `loadIndex`, `setIndex`, `clearIndexes`. A base URL change clears that delivery's index and reloads it.
- `catalog.ts`: pure derivation (`streamsFromIndexes`, presets, `resolveStream`), no module-global state.

## Work, in order

1. **`shared/src/deliveries.ts` and `shared/src/settings.ts`, with tests.** Pure. Covers `validateGroup` (good and bad values for every field), `resolve` (override wins, unset falls back, unknown keys ignored), and the delivery table (ids, order, prefixes match today's `INDEX_PREFIX`). Gate: `node --test shared/`.
2. **Web: the Delivery module and the split, with no API yet.** `catalog.ts` reads the shared delivery table and `deliveries.ts`; the index store moves out; defaults come from `import.meta.env` exactly as now. A pure refactor: behaviour identical. Gate: `tsc -b`, `vitest run` (the existing catalog and deliveries tests must pass with only import changes, which is the proof nothing changed), `vite build`, Player loads.
3. **Migration `002-settings.sql` and `db/settings.mjs`** (`get`, `set(group, value, { userId, ifRevision })`, `unset`, `revision`), with DB tests on `openTestDb` (they skip without Postgres, like the others). Gate: `node --test pipeline/` with the db container up.
4. **API routes** in `server.mjs`: public `GET /settings`, admin-only `PUT` and `DELETE`, validation errors as `400` with the field errors, `409` on a stale revision, `403` for a non-admin. Tests in a new `server.settings.test.mjs`, alongside the existing `server.auth.test.mjs` style (including "signed out can read, cannot write").
5. **Web fetches settings.** On load, `GET /api/pipeline/settings`, `applySettings`, re-render; on failure keep env defaults and show the "settings unavailable" notice; re-fetch when the tab regains focus. Tests with a fetch stub: override applied, failure falls back, a base URL change clears and reloads that delivery's index. Gate: Player in a browser, with the API up and then stopped.
6. **Pipeline reads packaging settings per job.** `createSteps` takes `getPackaging()` instead of fixing `kind` at start, so a toggled packager applies to the next upload with no restart; `PIPELINE_PACKAGER` / `PIPELINE_IMAGE` stay as the defaults it merges under. `bin/serve.mjs` passes the settings repo. Tests: a job after a settings change uses the new packager (stub steps, as `steps.ladder.test.mjs` does).
7. **Origin reads origin settings.** `tools/serve-origin.mjs` fetches `GET /settings` (5 s cache), applies `liveEnabled` and `liveWindow` (`buildLivePlaylist` takes the window as an argument instead of the `WINDOW` constant), and keeps last-known values if the fetch fails. Tests: pure (window parameter), plus a fetch-stub test of the cache and the fallback.
8. **Docs.** `CONTEXT.md` (Settings, Override, Group), `README` (the `VITE_*` table becomes "defaults; override in the GUI"), `docs/architecture.md`, and the `web/vite.config.ts` pinned test env comment.

## Verification

- `node --test shared/ scripts/ pipeline/ tools/` with `docker compose -f pipeline/compose.yaml up -d db` running, so the DB tests run instead of skipping.
- `cd web && npx tsc -b && npx vitest run && npm run build`.
- Manual, after item 5: `bash scripts/dev.sh`; with `curl -X PUT` (admin session) set the `s3-near` base and confirm the Player's picker updates after a refocus; stop the pipeline server and confirm the Player still loads on defaults with the notice.

## Risks and open questions

1. **`GET /settings` unauthenticated.** Needed so the Player works signed out, as it does today. If you'd rather gate it, the Player would need a login to see anything but `direct`. Recommended: public, with a hard rule that settings never hold secrets.
2. **"Origin CORS origins" is not a knob today.** The origin sends `Access-Control-Allow-Origin: *` unconditionally (`tools/serve-origin.mjs`), so there is nothing to override. I'd leave CORS out of the first version and make the origin group `liveEnabled` and `liveWindow` only. The pipeline API's own allowed origins stay boot-time env. Bench targets belong to step 4's bench workflow as inputs, not to settings.
3. **Effective vs stored.** The GUI should show, per field, the effective value and whether it is overridden or the default. That needs each client's defaults visible to the form; the plan has the web app compute them (it already has `import.meta.env`), and the pipeline and origin defaults are shown read-only as "default (env)" strings the API returns under a separate admin-only `GET /settings/defaults`. Decide in step 5 how much of this the first GUI needs.
4. **Disabling a delivery that a quadrant is using.** Recommended: it disappears from the picker, and a quadrant already on it shows "disabled in settings" instead of silently switching.
5. **Concurrency.** The `If-Match` revision check is more than a single local user strictly needs. It is cheap, and the GUI is the only writer today, so it could be dropped; I'd keep it because two open tabs is the realistic way to lose an edit.
6. **A write that breaks the app.** A bad `base` (a URL that 404s) is valid input; the Player already reports `HTTP 404 from <url>` per delivery, so a mistake is visible and reversible. The schema validates shape (a URL, a known enum), not reachability.
7. **Where the `VITE_*` defaults go once the GUI exists.** They stay: they are the fallback when the API is down and the first-run behaviour. Removing them would make the Player depend on the API, which the interview ruled out.

## Where this goes

Step 4 adds the workflow registry and bench extraction; its workflows read settings (for example the S3 bucket and the delivery bases to benchmark) through the same `resolve`. Step 5's Settings page renders the shared schema, one form per group, with `validateGroup` for inline errors and a "default / overridden" badge per field.
