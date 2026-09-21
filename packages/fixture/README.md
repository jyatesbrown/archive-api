# @archive-api/fixture

Deterministic synthetic source emitted in exactly the on-disk layout that
[archive-harness](https://github.com/jyatesbrown/archive-harness) writes, so the
query engine and API can be proven against known pathologies before they ever
see a real source.

```
<out>/harness.sqlite                                   append-only SQLite (harness schema + triggers)
<out>/payloads/<source>/<YYYY>/<MM>/<ts>-<sha12>.raw    raw JSON payloads, one per capture
<out>/fixture-manifest.json                            fixture-only: where every pathology lives
```

The contract is copied from the harness, not assumed:

- `contract/harness-schema.sql` is `harness/db.py` `SCHEMA` + append-only triggers at the pinned commit.
- `src/harness-contract.ts` reproduces `value_hash`, `compose_key`, the payload
  locator, the 40% count rule and the rolling-window test. CI runs the harness's
  own Python adapter over a generated fixture (`scripts/harness_parity.py`) and
  requires byte-identical `record_index` / `source_health` rows and a clean
  `harness verify`.

## Generate

```sh
pnpm --filter @archive-api/fixture build
node packages/fixture/dist/cli.js --out fixture-data/small --profile small   # 400 keys x 120 days, <1s, 12 MB
node packages/fixture/dist/cli.js --out fixture-data/spec                    # 50k keys x 400 days, ~3.5 min, ~5 GB
```

Same seed => byte-identical output. The target directory must be empty.

## Pathologies (all tagged in `fixture-manifest.json` → `cases`)

| case                  | what the store contains                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `resurrect`           | key absent for 30 captures, returns with a different value hash (`removed` then `reappeared`)               |
| `resurrect_identical` | key absent, returns byte-identical (same hash, same serialised record)                                      |
| `silent_field`        | `internal_note` (an `ignore_fields` entry) changes in the raw payload; value hash and diff are unchanged     |
| `missing_day`         | no `snapshots` row and no payload for one calendar date                                                     |
| `truncated_day`       | payload with ~40% of keys is stored, recorded `validation_failed`, nothing indexed; next diff skips it      |
| `aged_out`            | cohort created `window_days - 30` days before day 0 leaves on day 31 as `aged_out`, never `removed`         |
| `key_reuse`           | key retired, then re-issued to a different `entity`; indistinguishable from `resurrect` without the payload |

Day indices in the manifest map to dates via `manifest.dates[day]`.
