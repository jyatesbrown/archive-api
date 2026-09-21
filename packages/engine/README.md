# @archive-api/engine

Pure point-in-time query engine over an `archive-harness` snapshot store.
Zero runtime dependencies, no I/O: every function takes a `SnapshotStore`
(an async read-only interface) and returns plain data.

```ts
import { asOf, diff, history, type SnapshotStore } from '@archive-api/engine';

const r = await asOf(store, '2025-03-01|R000123', '2025-06-14');
switch (r.resolution) {
  case 'exact':            // an ok capture on that date holds the key
  case 'carried_forward':  // no ok capture that day; identical value_hash on both sides
  case 'absent':           // an ok capture that day (or both bounding captures) lack the key
  case 'unknown_gap':      // no capture that day and the value cannot be bounded
}
```

## Semantics (never invent state)

| Situation on requested date | `asOf` |
| --- | --- |
| ok capture, key present | `exact` — payload, `valueHash`, `capture` |
| ok capture, key absent | `absent` with `capture` |
| no ok capture, same hash before **and** after | `carried_forward` — payload from `before`, both bounds in provenance |
| no ok capture, absent before **and** after | `absent` with `before`/`after` |
| no ok capture, hash differs / present on one side only | `unknown_gap` (`state_changed_across_gap`) |
| before first / after last ok capture, or none at all | `unknown_gap` (`before_first_capture` / `after_last_capture` / `no_captures`) |

Rejected captures (`validation_failed`, `fetch_failed`, ...) never supply state.
They are surfaced in `rejectedOnDate` / `gaps[].rejected` and included in
provenance so callers can explain *why* a day has no state.

`diff(from, to)` requires an ok capture on both dates (`NoCaptureError` names
the nearest ones). Keys missing at `to` are split into `removed` and `agedOut`
using the source's rolling window evaluated at `to`, exactly as the harness's
`Window.is_outside` does. Outputs are sorted for stable cursor pagination.

`history(key)` walks ok captures in chain order and emits `appeared`,
`mutated`, `removed`, `aged_out`, `reappeared` transitions, `absent` and
`no_capture` gaps, and `reused: true` (with per-field evidence) when a key
comes back bound to a different entity per `SourceMeta.entityFields`.

Every result carries `provenance`: source id/name/upstream URL and, for each
contributing capture, `fetchedAt`, `contentHash` (raw SHA-256), `prevHash`,
`chainIndex` and `rawPath`.

## Store adapters

`MemoryStore` ships with the package (pure). A SQLite/payload-directory
adapter over the harness layout lives in `tests/sqlite-store.ts` and is the
reference for the Worker's R2/D1 adapter.
