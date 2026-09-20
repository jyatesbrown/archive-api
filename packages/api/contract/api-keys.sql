-- API keys live in the same D1 database as the harness index. The Worker only
-- ever SELECTs from this table; rows are written by scripts/mint-key.ts and
-- revoked with a plain UPDATE (see RUNBOOK.md).
CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY,           -- uuid, the meter subject
    prefix      TEXT NOT NULL,              -- ak_live_xxxxxxxx: shown to support, never secret
    key_hash    TEXT NOT NULL UNIQUE,       -- sha256 hex of the full plaintext key
    tier        TEXT NOT NULL CHECK (tier IN ('free','indie','team','bulk')),
    owner       TEXT,                       -- email / org label
    created_at  TEXT NOT NULL,
    revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys(prefix);
