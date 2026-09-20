# archive-api

Metered, source-agnostic HTTP API serving point-in-time queries (as-of, diff,
lifecycle) over the append-only snapshot store that
[`archive-harness`](https://github.com/jyatesbrown/archive-harness) writes to
Cloudflare R2. Work Order 003.

The harness is read, never modified. Everything here is built and proven
against a synthetic fixture before it is pointed at a real source.

## Layout

```
packages/
  fixture/   Task 1 — deterministic synthetic source in the harness's on-disk layout
  engine/    Task 2 — pure asOf / diff / history over a capture index (no I/O)
  api/       Task 3+4 — Cloudflare Worker: routes, caching, keys, metering, billing
apps/
  docs/      Task 5 — Astro static docs + live console, one page per source (Cloudflare Pages)
RUNBOOK.md   deploy, key rotation, adding a source, failed-capture response
```

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Node >= 22.13 (the fixture generator writes SQLite through `node:sqlite`).
