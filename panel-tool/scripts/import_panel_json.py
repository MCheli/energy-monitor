#!/usr/bin/env python3
"""One-shot importer: reads a legacy panel.json file and stores it in the DB.

Usage:
    DATABASE_URL=postgresql://... \
    SECRET_KEY=... \
    PANEL_TOOL_DATA_DIR=/tmp/scratch \
        python -m scripts.import_panel_json /path/to/panel.json

Idempotent: re-running just overwrites the single panel_state row.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <panel.json>", file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    if not src.exists():
        print(f"file not found: {src}", file=sys.stderr)
        return 1

    # Late import so the help message above doesn't require a configured env.
    from app import db
    from app import panel as panel_mod

    raw = json.loads(src.read_text())
    normalized = panel_mod.normalize_panel(raw)

    db.init_schema()
    db.save_panel(normalized)
    print(f"imported: {len(normalized.get('cts', []))} CTs, "
          f"{len(normalized.get('left', []))} left + {len(normalized.get('right', []))} right breakers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
