"""Cross-check a generated fixture against the real archive-harness code.

Usage: PYTHONPATH=<archive-harness checkout> python3 harness_parity.py <fixture-dir>

Runs the harness's own adapter (GenericJsonAdapter.extract / .fingerprint) over
every stored payload and asserts it reproduces record_index and source_health
byte-for-byte, then runs `harness verify` for the hash chain. Read-only.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

from harness.adapters.generic_json import GenericJsonAdapter


def main(fixture_dir: str) -> int:
    root = Path(fixture_dir)
    db = sqlite3.connect(f"file:{root / 'harness.sqlite'}?mode=ro", uri=True)
    payloads = root / "payloads"

    _, endpoint, cfg = db.execute("SELECT id, endpoint, adapter_config FROM sources").fetchone()
    adapter = GenericJsonAdapter(endpoint, **json.loads(cfg))

    checked = bad = 0
    rows = db.execute(
        "SELECT s.id, s.raw_path, s.outcome, h.fingerprint FROM snapshots s "
        "LEFT JOIN source_health h ON h.snapshot_id = s.id ORDER BY s.id"
    ).fetchall()
    for sid, raw_path, outcome, fp in rows:
        raw = (payloads / raw_path).read_bytes()
        if adapter.fingerprint(raw).as_text() != fp:
            bad += 1
            print(f"snapshot {sid}: fingerprint mismatch")
        if outcome != "ok":
            continue
        extracted = dict(adapter.extract(raw))
        indexed = dict(db.execute("SELECT record_key, value_hash FROM record_index WHERE snapshot_id = ?", (sid,)))
        checked += 1
        if extracted != indexed:
            bad += 1
            diff = list(set(extracted.items()) ^ set(indexed.items()))[:3]
            print(f"snapshot {sid}: record_index mismatch ({len(extracted)} vs {len(indexed)}), e.g. {diff}")
    print(f"extract parity: {checked} ok snapshots checked, {bad} mismatches")

    verify = subprocess.run(
        [sys.executable, "-m", "harness", "--db", str(root / "harness.sqlite"), "--payloads", str(payloads), "verify"],
        capture_output=True,
        text=True,
    )
    print(verify.stdout.strip())
    if verify.returncode != 0:
        print(verify.stderr)
    return 1 if bad or verify.returncode != 0 else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
