#!/usr/bin/env bash
# Incrementally project a harness store into the Worker's D1 (and optionally R2).
#
#   sync.sh --db PATH [--payloads DIR] [--source NAME] [--local] [--dry-run]
#
# Reads the highest snapshot id already in D1, exports only newer snapshots with
# load-fixture.ts, applies the SQL, and (when --payloads is given) uploads the
# new raw payloads. Everything applied is INSERT OR IGNORE / OR REPLACE on the
# harness's own primary keys, so an interrupted run can simply be re-run.
#
# Intended to run on the harness host right after deploy/run_daily.sh, with
# CLOUDFLARE_API_TOKEN (D1 write + R2 object write) and CLOUDFLARE_ACCOUNT_ID
# in the environment. --local targets `wrangler dev` stores instead.
set -euo pipefail

DB=""; PAYLOADS=""; SOURCE=""; MODE="--remote"; DRY=0
D1_NAME="${D1_NAME:-archive-index}"
BUCKET="${BUCKET:-archive-store}"
PREFIX="${PAYLOAD_PREFIX:-payloads/}"
OUT="${OUT:-$(mktemp -d)}"

while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="$2"; shift 2 ;;
    --payloads) PAYLOADS="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --local) MODE="--local"; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DB" ] || { echo "usage: sync.sh --db PATH [--payloads DIR] [--source NAME] [--local] [--dry-run]" >&2; exit 2; }

cd "$(dirname "$0")/.."
W="pnpm exec wrangler"

# Ensure the tables exist before asking for the watermark (first run on an empty database).
$W d1 execute "$D1_NAME" $MODE --command "CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, fetched_at TEXT NOT NULL, http_status INTEGER, byte_length INTEGER, content_hash TEXT, prev_hash TEXT, raw_path TEXT, adapter_version TEXT NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('ok','fetch_failed','extract_failed','validation_failed','robots_disallowed')), detail TEXT, duration_s REAL)" >/dev/null

if [ -n "$SOURCE" ]; then
  Q="SELECT COALESCE(MAX(s.id),0) AS id FROM snapshots s JOIN sources src ON src.id = s.source_id WHERE src.name = '$SOURCE'"
else
  Q="SELECT COALESCE(MAX(id),0) AS id FROM snapshots"
fi
AFTER="$($W d1 execute "$D1_NAME" $MODE --json --command "$Q" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(String(r[0].results[0].id))})' \
  || echo 0)"
echo "D1 watermark: snapshot id $AFTER"

ARGS=(--db "$DB" --payloads "${PAYLOADS:-/nonexistent}" --out "$OUT" --bucket "$BUCKET" --prefix "$PREFIX" --after-snapshot-id "$AFTER")
[ -n "$SOURCE" ] && ARGS+=(--source "$SOURCE")
node --experimental-strip-types scripts/load-fixture.ts "${ARGS[@]}"

if [ "$DRY" = 1 ]; then echo "dry run; artefacts in $OUT"; exit 0; fi

$W d1 execute "$D1_NAME" $MODE --file "$OUT/schema.sql" >/dev/null
for f in "$OUT"/data-*.sql; do
  [ -e "$f" ] || break
  $W d1 execute "$D1_NAME" $MODE --file "$f" >/dev/null
  echo "applied $(basename "$f")"
done

if [ -n "$PAYLOADS" ]; then
  if [ "$MODE" = "--local" ]; then WRANGLER_FLAGS=--local bash "$OUT/upload-payloads.sh"; else bash "$OUT/upload-payloads.sh"; fi
fi

echo "sync complete: $(cat "$OUT/watermark.json")"
