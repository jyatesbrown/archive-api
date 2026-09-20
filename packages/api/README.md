# @archive-api/api

Cloudflare Worker exposing point-in-time queries over an archive-harness store.
The Worker is read-only: D1 holds the harness index tables (`sources`,
`snapshots`, `record_index`), R2 holds the raw payloads at
`PAYLOAD_PREFIX + snapshots.raw_path`. All query semantics live in
`@archive-api/engine`; this package only does HTTP, caching, paging and logging.

## Endpoints

| Route | Purpose | Cache |
|---|---|---|
| `GET /health` | liveness, version, configured source count | `no-store` |
| `GET /v1/sources` | sources with capture bounds/counts | 60s |
| `GET /v1/{source}/asof?key=K&date=D` | state of K on D: `exact` / `carried_forward` / `absent` / `unknown_gap` | immutable when D ≤ last capture, else 60s |
| `GET /v1/{source}/diff?from=D1&to=D2[&limit=N][&cursor=C][&include=payload]` | added / removed / mutated / aged_out between two captures | immutable |
| `GET /v1/{source}/history?key=K` | full timeline of K with first/last seen, gaps, reuse evidence | 60s |

Every 200 body carries `provenance` (`source.{id,name,upstreamUrl}` and the
contributing `captures[]` with `fetchedAt`, `contentHash` (sha256 of the raw
payload), `prevHash`, `chainIndex`, `rawPath`).

Errors are RFC 9457 `application/problem+json` with a stable `code`:
`missing_parameter`, `invalid_parameter`, `invalid_cursor`, `unknown_source`,
`not_found`, `method_not_allowed`, `no_capture` (422, with `nearest_before`,
`nearest_after`, `rejected_on_date`), `internal`.

### Diff paging

`diff` walks `added → removed → mutated → aged_out`, each sorted by key. Pages
are `limit` entries (default 100, max 1000). `next_cursor` is an opaque
base64url token and `next_url` is ready to follow; there is no offset
parameter. Entries always carry the `before`/`after` value hashes; add
`include=payload` to inline the raw records.

### Caching

Responses are cached in the Workers Cache keyed by
`origin + path + sorted query string` (source, endpoint and every parameter),
never by caller. Problems are never cached. `x-cache: HIT|MISS` is set on
query routes.

### Logging

One JSON line per request: `ts, request_id, method, endpoint, source,
record_key, status, latency_ms, cache, tier, key_prefix, problem`. Payload
contents never appear. `tier`/`key_prefix` are filled in by the auth layer
(Task 4); anonymous requests log `tier: "anonymous"`.

## Configuration (`wrangler.toml`)

- `DB` — D1 database with the harness tables (see `scripts/load-fixture.ts`
  for `schema.sql`).
- `PAYLOADS` — R2 bucket with raw payloads.
- `PAYLOAD_PREFIX` — key prefix in front of `raw_path` (default `payloads/`).
- `SOURCE_CONFIG` — JSON `{ "<source name>": { "entityFields": [...] } }`;
  `entityFields` are the payload fields that identify the real-world entity,
  used to tell key reuse from resurrection.

The `database_id` / `bucket_name` in `wrangler.toml` are placeholders until
resources are provisioned (RUNBOOK, Task 5).

## Loading a store

```
pnpm --filter @archive-api/fixture build
node packages/fixture/dist/cli.js --out fixture-data/small --profile small
pnpm --filter @archive-api/api fixture:load -- --db fixture-data/small/harness.sqlite \
  --payloads fixture-data/small/payloads --out /tmp/d1-load
# then, with your own wrangler login:
wrangler d1 execute archive-index --remote --file /tmp/d1-load/schema.sql
for f in /tmp/d1-load/data-*.sql; do wrangler d1 execute archive-index --remote --file "$f"; done
BUCKET=archive-store /tmp/d1-load/upload-payloads.sh
```

## Tests

`pnpm test` — 64 tests: unit tests for problem/cursor/cache/logging/config,
route contract tests over an in-memory store, and integration tests over the
real fixture output through the SQL/blob store (one named test per pathology,
plus a full multi-page cursor walk). The D1/R2 binding shims
(`src/stores/cloudflare.ts`) are the only untested code; they need the Workers
runtime.
