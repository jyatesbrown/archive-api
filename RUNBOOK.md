# RUNBOOK — archive-api

Operational procedures for the API Worker (`packages/api`) and the docs site
(`apps/docs`). The archive itself is produced by
[`archive-harness`](https://github.com/jyatesbrown/archive-harness); this
repo only reads it. Nothing here writes to the harness bucket's `harness.sqlite`
or `payloads/` — if a step below seems to require that, stop.

Contents

1. [Topology](#1-topology)
2. [Local development](#2-local-development)
3. [Deploy](#3-deploy)
4. [API keys: mint, rotate, revoke](#4-api-keys-mint-rotate-revoke)
5. [Adding a source](#5-adding-a-source)
6. [When a daily capture fails](#6-when-a-daily-capture-fails)
7. [Verification checklist](#7-verification-checklist)
8. [Rollback](#8-rollback)

---

## 1. Topology

```
archive-harness (daily, deploy/run_daily.sh)
   └─ R2 bucket            harness.sqlite (current index), db-history/…, payloads/<source>/YYYY/MM/<ts>-<sha12>.raw
                                  │                                   │
        packages/api/scripts/sync.sh (incremental projection)          │  read-only binding PAYLOADS
                                  ▼                                   ▼
Cloudflare D1 "archive-index"  sources / snapshots / record_index / api_keys
Cloudflare Worker "archive-api"  GET /v1/{source}/{asof,diff,history}  GET /v1/sources  GET /health
Durable Object MonthlyCounter    per-key monthly call meter
Cloudflare Pages (apps/docs)     static docs + live console calling PUBLIC_API_URL
```

| Thing | Where | Notes |
|---|---|---|
| Worker config | `packages/api/wrangler.toml` | `SOURCE_CONFIG`, `PAYLOAD_PREFIX`, `PRICING_URL`, `BILLING_PROVIDER`, bindings |
| D1 schema (harness tables) | emitted by `scripts/export-store.ts` as `schema.sql` | mirrors harness `record_index` etc.; additive only |
| Worker deploy | `.github/workflows/deploy.yml` on push to `main` | skipped until `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets exist |
| D1 schema (keys) | `packages/api/contract/api-keys.sql` | `api_keys` table, hashes only |
| Docs config | `apps/docs/src/config/{site,sources}.ts` | `PUBLIC_SITE_URL` / `PUBLIC_API_URL` at build time |
| Tier ladder | `packages/api/src/auth/tiers.ts` | Free 1k/90d, Indie 25k, Team 250k, Bulk unmetered |

Everything in D1 is a **projection** of `harness.sqlite`. It can be rebuilt from
the bucket at any time; it is never the source of truth. `api_keys` is the one
table the API owns.

## 2. Local development

Requirements: Node ≥ 22.13 (see `.nvmrc`), pnpm 9.15 via corepack, `wrangler`
(installed as a devDependency of `packages/api`).

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test      # whole workspace, incl. docs canonical check
pnpm fixture:generate                          # -> fixture-data/small (400 keys x 120 days)
```

Run the Worker against local D1/R2 with real fixture data (this is the exact
path the docs console exercises; ~2 min):

```bash
cd packages/api
# 1. index + payloads into wrangler's local D1/R2 (same script as production, §3.2)
bash scripts/sync.sh --db ../../fixture-data/small/harness.sqlite \
  --payloads ../../fixture-data/small/payloads --local
pnpm exec wrangler d1 execute archive-index --local --file contract/api-keys.sql
# 2. serve
pnpm exec wrangler dev --local --port 8787
curl 'localhost:8787/v1/fixture_registry/asof?key=2025-01-01%7CR000000&date=2025-02-01'
```

Docs against that local Worker:

```bash
cd apps/docs
PUBLIC_API_URL=http://localhost:8787 pnpm dev        # or pnpm build && pnpm preview
```

## 3. Deploy

### 3.1 One-time Cloudflare setup

```bash
cd packages/api
pnpm exec wrangler login
pnpm exec wrangler d1 create archive-index          # paste database_id into wrangler.toml
pnpm exec wrangler r2 bucket create archive-store   # or reuse the harness bucket (read-only token)
pnpm exec wrangler d1 execute archive-index --remote --file contract/api-keys.sql
```

Point `PAYLOADS` at the bucket that `archive-harness/deploy/run_daily.sh`
syncs to, with `PAYLOAD_PREFIX` equal to its `payloads/` prefix. The Worker
only calls `get()` on R2; use a bucket token scoped to object read.

### 3.2 Load / refresh the index (after every harness run you want visible)

`packages/api/scripts/sync.sh` is the one command. It reads the highest
`snapshots.id` already in D1, exports only newer snapshots (plus their
`record_index` rows and raw payloads) with `scripts/export-store.ts`, and
applies them. Because the harness only appends snapshots, that single integer
is a complete watermark; a first run on an empty D1 loads everything.

```bash
cd packages/api
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…    # D1 edit (+ R2 object write if uploading payloads)

# Harness host, right after deploy/run_daily.sh (cron) — DB and payloads are local:
bash scripts/sync.sh --db /path/to/harness/data/harness.sqlite --payloads /path/to/harness/data/payloads

# Anywhere else — payloads already in the bucket via the harness's own s3 sync, so only the index:
aws --endpoint-url "$R2_ENDPOINT_URL" s3 cp "s3://$R2_BUCKET/harness.sqlite" /tmp/harness.sqlite
bash scripts/sync.sh --db /tmp/harness.sqlite
```

Flags: `--source NAME` (one source; watermark is then per source), `--local`
(wrangler dev stores), `--dry-run` (export only, prints the artefact dir).
Env: `D1_NAME`, `BUCKET`, `PAYLOAD_PREFIX` (must equal the Worker var).

All statements are `INSERT OR IGNORE` (`INSERT OR REPLACE` for `sources`
metadata) on the harness's own primary keys, so an interrupted run is simply
re-run. Never `DELETE` from the harness tables in D1; if a projection is wrong,
rebuild the database (§8). The lower-level `pnpm fixture:load --after-snapshot-id N`
is what `sync.sh` calls; use it to inspect the SQL before applying.

### 3.3 Deploy the Worker

Automatic: `.github/workflows/deploy.yml` runs on every push to `main` that
touches `packages/api` or `packages/engine` (and on `workflow_dispatch`). It
builds, typechecks, tests, applies `contract/api-keys.sql`, then
`wrangler deploy`. It needs repository secrets `CLOUDFLARE_API_TOKEN`
(permissions: Workers Scripts:Edit, D1:Edit, Account Settings:Read) and
`CLOUDFLARE_ACCOUNT_ID`; without them the job logs "skipping deploy" and
succeeds. Set repository variable `API_URL` (e.g. `https://api.archive-api.dev`)
to get a post-deploy smoke test of `/health` and `/v1/sources`.

Manual:

```bash
cd packages/api
pnpm test && pnpm typecheck
pnpm exec wrangler deploy                # first deploy also applies the DO migration "v1"
curl -s https://<worker-host>/health     # {"status":"ok","sources":N,...}
curl -s -D - -o /dev/null 'https://<worker-host>/v1/fixture_registry/asof?key=2025-01-01%7CR000000&date=2025-02-01' \
  | grep -i 'HTTP/\|cache-control\|x-tier'
```

Expect `200`, `Cache-Control: public, max-age=31536000, immutable`, `x-tier: anonymous`.

### 3.4 Deploy the docs (Cloudflare Pages)

Pages project settings:

| Setting | Value |
|---|---|
| Root directory | `/` (monorepo; pnpm workspace) |
| Build command | `pnpm install --frozen-lockfile && pnpm --filter @archive-api/docs build` |
| Build output | `apps/docs/dist` |
| Env `NODE_VERSION` | `22` |
| Env `PUBLIC_SITE_URL` | `https://docs.archive-api.dev` (bare https origin) |
| Env `PUBLIC_API_URL` | `https://api.archive-api.dev` (bare https origin) |

The build **fails** if any page's `<link rel="canonical">`/`og:url` disagrees
with `PUBLIC_SITE_URL` + route + `/`, if a page is emitted as `foo.html`
instead of `foo/index.html`, or if an internal link lacks the trailing slash
(`apps/docs/scripts/check-canonical.ts`). Custom domain: attach
`docs.archive-api.dev` to the Pages project; Pages 301s `/x` → `/x/` for
directory output. Preview deploys (branch builds) get their own
`*.pages.dev` origin — set `PUBLIC_SITE_URL` per environment or canonicals will
(correctly) point at production.

Manual deploy from a laptop: `pnpm --filter @archive-api/docs build && pnpm exec wrangler pages deploy apps/docs/dist --project-name archive-api-docs`.

The console on the landing page makes a real request to `PUBLIC_API_URL`
without a key; it works because `fixture_registry` is configured
`openArchive: true` (whole history readable, still metered against the
anonymous 100/month allowance). `apps/docs/tests/sources.test.ts` fails the
docs build if `src/config/sources.ts` drifts from `wrangler.toml`'s
`SOURCE_CONFIG`.

## 4. API keys: mint, rotate, revoke

Plaintext key format `ak_<live|test>_<prefix8>_<secret32>`. D1 stores only
`sha256(plaintext)` and the prefix. **The plaintext is shown exactly once**, at
mint time, on stdout. There is no recovery path — rotate instead.

### Mint

```bash
cd packages/api
pnpm key:mint --tier indie --owner customer@example.com --env live
#   stdout: ak_live_xxxxxxxx_…   (send to the customer over a private channel, then discard)
#   stderr: INSERT INTO api_keys (...) VALUES (...);
pnpm exec wrangler d1 execute archive-index --remote --command "<the INSERT from stderr>"
```

Tiers: `free | indie | team | bulk` (`src/auth/tiers.ts`). Use `--env test`
for keys that should be obviously non-production.

### Rotate (customer keeps service; old key stops working)

1. Mint a new key for the same owner/tier (above).
2. Deliver it; confirm they've switched (their `x-ratelimit-used` moves to the
   new prefix — check with `SELECT prefix, tier, owner FROM api_keys WHERE owner = '…'`).
3. Revoke the old one:

```bash
pnpm exec wrangler d1 execute archive-index --remote --command \
  "UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE prefix = 'ak_live_xxxxxxxx' AND revoked_at IS NULL"
```

Revocation is immediate (the Worker looks up the hash on every request;
`/v1` responses to a revoked key are `401 invalid_api_key`). Do not delete
rows: `revoked_at` is the audit trail and the meter DO is keyed by key id.

### Compromised key

Revoke first (step 3), then mint. Usage under the old key for the current
month remains attributed to it in the `MonthlyCounter` DO — nothing to clean up.

### Meter reset / overage disputes

Counters are per `key:<id>` per UTC month and roll over automatically. Paid
tiers are never blocked; overage is recorded via `BillingProvider.reportUsage`
(currently `noop`, which logs). To inspect a key's month, hit any `/v1` route
with the key and read `x-ratelimit-used`.

## 5. Adding a source

Prerequisite: the source already exists in the harness (`sources.json`,
adapter, at least one successful daily run) and has rows in `sources` /
`snapshots` / `record_index` of `harness.sqlite`. This repo never defines
what a source *is*; it only exposes what the harness captured.

1. **Worker config** — `packages/api/wrangler.toml`:
   ```toml
   SOURCE_CONFIG = '{"fixture_registry":{...},"new_source":{"entityFields":["company_id"]}}'
   ```
   `entityFields` are the payload fields `diff` groups by. Add
   `"openArchive": true` only for sample/public-domain sources whose full
   history should be free — it disables the lookback window for every tier.
   Source names must match `sources.name` in the harness DB exactly.
2. **Project the index** for that source (§3.2 with `--source new_source`).
   Payloads are already in R2 under `PAYLOAD_PREFIX`.
3. **Docs** — add an entry to `apps/docs/src/config/sources.ts` with a
   `sample` query that returns a real answer (key + date inside the archive).
   `pnpm --filter @archive-api/docs test` fails until the docs list matches
   `SOURCE_CONFIG` exactly (names, `entityFields`, `openArchive`). The build
   then emits `/sources/new_source/` automatically.
4. **Deploy** Worker then docs (§3.3, §3.4). Verify:
   ```bash
   curl -s https://<worker-host>/v1/sources | jq '.sources[] | select(.name=="new_source")'
   curl -s -o /dev/null -w '%{http_code}\n' 'https://<worker-host>/v1/new_source/history?key=<some key>'
   ```
   `404 unknown_source` means D1 has no `sources` row for it (step 2);
   `402 lookback_exceeded` on an anonymous call is expected for non-open
   sources when the date is older than 90 days.

Removing a source: drop it from `SOURCE_CONFIG` and `sources.ts` (the docs
test enforces both). Leave its D1 rows in place; the Worker only serves
configured sources.

## 6. When a daily capture fails

The harness, not this repo, does the capturing; but the API is where users
notice. `run_daily.sh` exit codes: `0` ok · `1` run completed with alerts
(some source failed) · `2` state could not be pulled/pushed (run does not
count).

### 6.1 Triage (5 minutes)

```bash
aws --endpoint-url "$R2_ENDPOINT_URL" s3 ls "s3://$R2_BUCKET/summaries/" | tail -3   # did today's run write a summary?
aws --endpoint-url "$R2_ENDPOINT_URL" s3 cp "s3://$R2_BUCKET/summaries/<latest>.txt" -          # which sources, which outcome
aws --endpoint-url "$R2_ENDPOINT_URL" s3 cp "s3://$R2_BUCKET/harness.sqlite" /tmp/h.sqlite
sqlite3 /tmp/h.sqlite "SELECT s.name, sn.fetched_at, sn.outcome, sn.detail FROM snapshots sn JOIN sources s ON s.id=sn.source_id ORDER BY sn.id DESC LIMIT 10"
sqlite3 /tmp/h.sqlite "SELECT * FROM alerts ORDER BY id DESC LIMIT 10"
```

### 6.2 What the API does on its own

Nothing needs to be "fixed" in the API for a missed or failed day — this is
the designed behaviour and it is tested (`missing_day`, `truncated_day`
pathologies):

| Harness outcome | Row in `snapshots`? | API behaviour |
|---|---|---|
| No run at all (exit 2, cron didn't fire) | no | `asof` for that date returns `resolution: "carried_forward"` only when the nearest ok captures on **both** sides agree on the value; otherwise `"unknown_gap"` (or `"absent"` if both sides lack the key). `history` shows the gap; `diff` spanning the day is unaffected. Nothing is invented. |
| `fetch_failed` / `extract_failed` / `robots_disallowed` | yes, no `record_index` rows | same as above, plus the failed capture appears in `rejectedOnDate` / `provenance.captures` so the caller can see *why* there is no state. |
| `validation_failed` (truncated / short page) | yes, no `record_index` rows | same — keys are **not** marked as disappeared. Only an `ok` capture without the key ends a lifespan. |
| `ok` but suspiciously small | yes, with rows | keys missing from it *do* count as disappeared. This is the one case that needs a human: see 6.4. |

`/health` stays `ok` — it reports the API's own dependencies, not capture
freshness. Capture freshness is visible per source via
`GET /v1/sources` (`captures`, `okCaptures`, `lastCapture`).

### 6.3 Runbook by cause

- **Runner didn't fire / exit 2 (bucket unreachable).** Re-run
  `deploy/run_daily.sh` manually in the harness repo once R2 is reachable. The
  harness refuses to start a new chain without `BOOTSTRAP=1`, so a late run is
  safe. Then project (§3.2). One day's gap is fine; the chain (`prev_hash`)
  stays intact because failed runs don't write snapshots.
- **One source failing (exit 1), others fine.** Project anyway so the healthy
  sources are current. Investigate the source in the harness (adapter change,
  robots, publisher moved the endpoint). Nothing to change here unless the
  source is being retired (§5, removal).
- **Publisher truncated the page (`validation_failed`).** Correct behaviour;
  the API shows the rejection in provenance. If it persists >3 days, consider
  `harness … accept --source X --note …` in the harness — that is a harness
  decision, made there, never by editing D1.
- **Run succeeded but D1 is stale** (users see an old `lastCapture`). §3.2
  (`sync.sh`) was not run or failed part-way. Re-run it; it resumes from the D1
  watermark and is idempotent. Then hit
  `/v1/sources` — cached for 60 s, so allow a minute.
- **`asof` returns `payload: null` with `resolution: "exact"`** after a
  projection. The index references a `raw_path` that isn't in R2 under
  `PAYLOAD_PREFIX`: the harness pushed the DB but the `s3 sync` of payloads
  failed. Re-run the harness push (or `aws s3 sync data/payloads
  s3://$R2_BUCKET/payloads`), never the API. `history`/`diff` keep working
  (they read `record_index` only); only payload bodies need the raw file.
  Those responses were served `immutable` — purge the Worker cache
  (`wrangler` → Caching → Purge by URL, or bump the Worker) once the objects exist.

### 6.4 Suspicious `ok` capture (the dangerous case)

A capture that validated but is much smaller than usual makes every missing
key look removed. Signals: a `diff` for that day with a large `removed` list
and near-zero `added`/`changed`; `history` for many keys ending on the same
date. Response: in the harness, tighten that source's validation (min record
count) so the day becomes `validation_failed`, and document it in the harness
`alerts`. The API does not get a "hide this snapshot" switch by design —
append-only means the capture stays, with its provenance, and the fix is
upstream.

## 7. Verification checklist

After any deploy:

```bash
H=https://<worker-host>
curl -s $H/health | jq .status                                          # "ok"
curl -s $H/v1/sources | jq '.sources | length'                            # == sources in SOURCE_CONFIG
curl -s -D - -o /dev/null "$H/v1/fixture_registry/asof?key=2025-01-01%7CR000000&date=2025-02-01" | grep -i 'HTTP/\|immutable'
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer ak_live_deadbeef_00000000000000000000000000000000' $H/v1/sources   # 401
curl -s -o /dev/null -w '%{http_code}\n' "$H/v1/fixture_registry/asof?key=x&date=2020-01-01"   # 200 (open source) — on a closed source: 402
```

Docs: open the landing page; the console must show a `200` with
`x-tier: anonymous` without entering a key. `view-source:` any page and check
`<link rel="canonical">` is `https://docs.archive-api.dev/<route>/`.

## 8. Rollback

- **Worker**: `pnpm exec wrangler rollback` (or `wrangler deployments list` then
  `wrangler rollback <id>`). Config changes to `SOURCE_CONFIG` are part of the
  deployment and roll back with it.
- **D1 projection**: there is no destructive projection path, so "rollback"
  means rebuilding: create a fresh D1 database, load `api-keys.sql`, copy the
  `api_keys` rows across (`wrangler d1 export … --table api_keys`), run §3.2
  from the desired `db-history/harness-<ts>.sqlite`, then switch
  `database_id` in `wrangler.toml` and deploy. Delete the old database only
  after the new one has served traffic for a day.
- **Docs**: Pages → Deployments → "Rollback to this deployment", or redeploy
  the previous commit. Canonicals are derived from `PUBLIC_SITE_URL`, so a
  rollback never changes URLs.
- **Keys**: never rolled back. Revocations stand; re-mint if needed.
