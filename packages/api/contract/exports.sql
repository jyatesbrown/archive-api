-- Bulk export ledger: one row per (key, source, export stamp) the Worker has
-- handed signed links for. Team keys get one per calendar quarter, bulk keys
-- one ever; re-requesting a stamp already granted re-signs links without a new
-- row. The only table the Worker writes to; the archive tables stay read-only.
CREATE TABLE IF NOT EXISTS bulk_exports (
    key_id     TEXT NOT NULL REFERENCES api_keys(id),
    source     TEXT NOT NULL,
    stamp      TEXT NOT NULL,
    issued_at  TEXT NOT NULL,
    PRIMARY KEY (key_id, source, stamp)
);
