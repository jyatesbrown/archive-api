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
`nearest_after`, `rejected_on_date`), `invalid_key` (401), `lookback_exceeded`
(402), `quota_exhausted` (429, anonymous only), `internal`.

## Auth, metering, lookback

Send the key as `Authorization: Bearer ak_live_…` (or `x-api-key`). No key is
allowed and treated as `anonymous`; a bad key is 401, never a silent downgrade.

| Tier | Calls / mo | Lookback | Past the allowance |
|---|---|---|---|
| anonymous (no key) | 100 per client address | 90 days | 429 `quota_exhausted` |
| free | 1,000 | 90 days | served; overage recorded ($1 / 1,000) |
| indie / team | 25,000 / 250,000 | full archive | served; overage recorded |
| bulk | unmetered | full archive | — |

- Keys (`src/auth/keys.ts`): `ak_<live|test>_<prefix8>_<secret32>`. Only
  `sha256(plaintext)` and the prefix are stored (`contract/api-keys.sql`,
  same D1 database). Mint with `pnpm key:mint --tier free --owner me@x`;
  the plaintext is printed once. Revoke with
  `UPDATE api_keys SET revoked_at = … WHERE prefix = 'ak_live_…'`.
- Meter (`src/auth/meter.ts`): one Durable Object per subject (`MonthlyCounter`),
  so concurrent calls never lose increments. Every `/v1` call counts, cache hits
  included; `/health` does not. Subjects are `key:<id>` or `anon:<sha256(ip)>`.
  Responses carry `x-tier`, `x-ratelimit-limit|used|remaining`, `x-overage-calls`.
- Lookback (`src/auth/guard.ts`): measured in calendar days from the request's
  UTC date. `asof?date` and `diff?from/to` earlier than the window are refused
  with 402 **before** the cache or store is touched; the body names
  `lookback_days`, `earliest_allowed` and `upgrade.{tier,checkoutUrl,pricingUrl}`.
  `history` has no date parameter, so it is truncated to the window instead and
  says so in `lookback` (`limited`, `earliest_allowed`, `omitted_transitions`);
  `firstSeen` is withheld rather than moved. Truncated and full histories use
  different cache entries.
- Billing (`src/auth/billing.ts`): `BillingProvider { reportUsage, checkoutUrl,
  pricingUrl }`. `reportUsage` is called off the request path exactly when a key
  crosses its allowance and at each further 1,000 calls. `NoopBilling` is the
  only implementation until the merchant-of-record account exists; select with
  `BILLING_PROVIDER`.

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
contents never appear, and neither do keys: only the `ak_live_xxxxxxxx` prefix.

## Configuration (`wrangler.toml`)

- `DB` — D1 database with the harness tables (see `scripts/load-fixture.ts`
  for `schema.sql`).
- `PAYLOADS` — R2 bucket with raw payloads.
- `PAYLOAD_PREFIX` — key prefix in front of `raw_path` (default `payloads/`).
- `METER` — Durable Object namespace bound to `MonthlyCounter`.
- `SOURCE_CONFIG` — JSON `{ "<source name>": { "entityFields": [...] } }`;
  `entityFields` are the payload fields that identify the real-world entity,
  used to tell key reuse from resurrection.
  `openArchive: true` lifts the lookback window for that source for every
  tier (sample data for the docs console); metering still applies.
- `PRICING_URL`, `BILLING_PROVIDER` (`noop`).

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

`pnpm test` — 95 tests: unit tests for problem/cursor/cache/logging/config,
route contract tests over an in-memory store, auth/metering/lookback/billing
tests with a fixed clock, and integration tests over the real fixture output
through the SQL/blob store (one named test per pathology, a full multi-page
cursor walk, a free-tier walk). The D1/R2/Durable Object binding shims
(`src/stores/cloudflare.ts`) are the only untested code; they need the Workers
runtime.
