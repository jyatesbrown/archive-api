-- Copied verbatim from archive-harness harness/db.py (SCHEMA + _trigger_sql) at commit 75c58f46583c0a9d3f39857cda38f3af7595af53.
-- This is the on-disk contract the fixture writes and the API reads. Do not edit here; re-copy from the harness.

CREATE TABLE IF NOT EXISTS sources (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    tier            TEXT NOT NULL,
    endpoint        TEXT NOT NULL,
    format          TEXT NOT NULL,
    adapter_module  TEXT NOT NULL,
    adapter_config  TEXT NOT NULL DEFAULT '{}',
    identity_key    TEXT NOT NULL,
    license_url     TEXT NOT NULL,
    window_days     INTEGER,
    window_key_part INTEGER,
    control_group   TEXT,
    timeout_s       REAL,
    cadence         TEXT,
    expected_silent INTEGER NOT NULL DEFAULT 0,
    unverified_contrary_claim INTEGER NOT NULL DEFAULT 0,
    exit_target     TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    added_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
    id              INTEGER PRIMARY KEY,
    source_id       INTEGER NOT NULL REFERENCES sources(id),
    fetched_at      TEXT NOT NULL,
    http_status     INTEGER,
    byte_length     INTEGER,
    content_hash    TEXT,
    prev_hash       TEXT,
    raw_path        TEXT,
    adapter_version TEXT NOT NULL,
    outcome         TEXT NOT NULL CHECK (outcome IN
                        ('ok','fetch_failed','extract_failed','validation_failed','robots_disallowed')),
    detail          TEXT,
    duration_s      REAL
);
CREATE INDEX IF NOT EXISTS snapshots_source_idx ON snapshots(source_id, id);

CREATE TABLE IF NOT EXISTS record_index (
    snapshot_id     INTEGER NOT NULL REFERENCES snapshots(id),
    record_key      TEXT NOT NULL,
    value_hash      TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, record_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS run_diffs (
    id              INTEGER PRIMARY KEY,
    source_id       INTEGER NOT NULL REFERENCES sources(id),
    snapshot_id     INTEGER NOT NULL REFERENCES snapshots(id),
    prev_snapshot_id INTEGER REFERENCES snapshots(id),
    added           INTEGER NOT NULL,
    removed         INTEGER NOT NULL,
    mutated         INTEGER NOT NULL,
    aged_out        INTEGER NOT NULL DEFAULT 0,
    reappeared      INTEGER NOT NULL DEFAULT 0,
    unchanged       INTEGER NOT NULL,
    classification  TEXT NOT NULL CHECK (classification IN
                        ('append_only','mutating','destructive','baseline'))
);

CREATE TABLE IF NOT EXISTS source_health (
    id              INTEGER PRIMARY KEY,
    source_id       INTEGER NOT NULL REFERENCES sources(id),
    snapshot_id     INTEGER NOT NULL REFERENCES snapshots(id),
    fingerprint     TEXT NOT NULL,
    record_count    INTEGER NOT NULL,
    drifted         INTEGER NOT NULL,
    drift_detail    TEXT
);

-- Lifecycle of keys that leave the record set. 'removed' when a key vanishes,
-- 'reappeared' when a previously removed key returns, 'aged_out' when a key
-- leaves a rolling window by creation date (not destruction), 'exited' when a
-- removed key is found in the key space of the source's exit_target.
CREATE TABLE IF NOT EXISTS key_events (
    id              INTEGER PRIMARY KEY,
    source_id       INTEGER NOT NULL REFERENCES sources(id),
    snapshot_id     INTEGER NOT NULL REFERENCES snapshots(id),
    record_key      TEXT NOT NULL,
    event           TEXT NOT NULL CHECK (event IN ('removed','reappeared','aged_out','exited'))
);
CREATE INDEX IF NOT EXISTS key_events_idx ON key_events(source_id, record_key, id);

CREATE TABLE IF NOT EXISTS alerts (
    id              INTEGER PRIMARY KEY,
    raised_at       TEXT NOT NULL,
    source_id       INTEGER REFERENCES sources(id),
    snapshot_id     INTEGER REFERENCES snapshots(id),
    kind            TEXT NOT NULL,
    message         TEXT NOT NULL
);

-- Operator acknowledgement that a structural fingerprint is the new expected
-- shape. Runs matching an accepted fingerprint are not rejected for drift;
-- the drift itself is still recorded in source_health.
CREATE TABLE IF NOT EXISTS drift_acceptances (
    id              INTEGER PRIMARY KEY,
    source_id       INTEGER NOT NULL REFERENCES sources(id),
    fingerprint     TEXT NOT NULL,
    accepted_at     TEXT NOT NULL,
    note            TEXT
);

CREATE TRIGGER IF NOT EXISTS sources_no_update BEFORE UPDATE ON sources BEGIN SELECT RAISE(ABORT, 'append-only: UPDATE on sources is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS sources_no_delete BEFORE DELETE ON sources BEGIN SELECT RAISE(ABORT, 'append-only: DELETE on sources is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS snapshots_no_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT, 'append-only: UPDATE on snapshots is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS snapshots_no_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT, 'append-only: DELETE on snapshots is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS record_index_no_update BEFORE UPDATE ON record_index BEGIN SELECT RAISE(ABORT, 'append-only: UPDATE on record_index is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS record_index_no_delete BEFORE DELETE ON record_index BEGIN SELECT RAISE(ABORT, 'append-only: DELETE on record_index is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS run_diffs_no_update BEFORE UPDATE ON run_diffs BEGIN SELECT RAISE(ABORT, 'append-only: UPDATE on run_diffs is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS run_diffs_no_delete BEFORE DELETE ON run_diffs BEGIN SELECT RAISE(ABORT, 'append-only: DELETE on run_diffs is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS source_health_no_update BEFORE UPDATE ON source_health BEGIN SELECT RAISE(ABORT, 'append-only: UPDATE on source_health is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS source_health_no_delete BEFORE DELETE ON source_health BEGIN SELECT RAISE(ABORT, 'append-only: DELETE on source_health is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS key_events_no_update BEFORE UPDATE ON key_events BEGIN SELECT RAISE(ABORT, 'append-only: UPDATE on key_events is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS key_events_no_delete BEFORE DELETE ON key_events BEGIN SELECT RAISE(ABORT, 'append-only: DELETE on key_events is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS alerts_no_update BEFORE UPDATE ON alerts BEGIN SELECT RAISE(ABORT, 'append-only: UPDATE on alerts is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS alerts_no_delete BEFORE DELETE ON alerts BEGIN SELECT RAISE(ABORT, 'append-only: DELETE on alerts is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS drift_acceptances_no_update BEFORE UPDATE ON drift_acceptances BEGIN SELECT RAISE(ABORT, 'append-only: UPDATE on drift_acceptances is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS drift_acceptances_no_delete BEFORE DELETE ON drift_acceptances BEGIN SELECT RAISE(ABORT, 'append-only: DELETE on drift_acceptances is forbidden'); END;
