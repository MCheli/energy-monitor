"""Runtime configuration — env vars only.

Anything that should be runtime-editable through the UI lives in the
`app_settings` table (see app.db). This module is for things that affect
how the process boots: DB URL, data directory, listen address, secret key.
"""
from __future__ import annotations

import os
from pathlib import Path


def _get(name: str, default: str | None = None, *, required: bool = False) -> str:
    val = os.environ.get(name, default)
    if required and not val:
        raise RuntimeError(f"{name} is required but not set")
    return val or ""


# Where the app keeps writable state on disk (snapshots, logs, the SQLite DB).
DATA_DIR = Path(_get("PANEL_TOOL_DATA_DIR", "/data"))

# Listen address.
HOST = _get("PANEL_TOOL_HOST", "0.0.0.0")
PORT = int(_get("PANEL_TOOL_PORT", "8000"))

# DB URL. Defaults to a SQLite file under DATA_DIR so a fresh `docker compose up`
# works without any setup. Operators wanting Postgres set DATABASE_URL.
DATABASE_URL = _get("DATABASE_URL", f"sqlite:///{DATA_DIR / 'panel.db'}")

# Secret used to encrypt sensitive runtime settings (HA tokens, etc.) at rest.
# Required in production; auto-generated for SQLite default if unset (dev only).
SECRET_KEY = _get("SECRET_KEY", "")

# Optional override: an HTTP basic-auth credential pair "user:password" the app
# will require on every request. The homelab pattern terminates auth at the
# reverse proxy, so this is off by default — turn it on if you expose the app
# more broadly.
BASIC_AUTH = _get("PANEL_TOOL_BASIC_AUTH", "")
