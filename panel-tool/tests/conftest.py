"""Pytest fixtures — every test gets a fresh SQLite DB in a tmp dir."""
from __future__ import annotations

import importlib
import os
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def fresh_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point every test at a unique data dir + SQLite DB and reload the
    config + db modules so they pick up the env vars."""
    monkeypatch.setenv("PANEL_TOOL_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PANEL_TOOL_PORT", "0")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'panel.db'}")
    monkeypatch.setenv("SECRET_KEY", "test32byteSecretKeyAaaaaaaaaaaa")
    monkeypatch.delenv("PANEL_TOOL_BASIC_AUTH", raising=False)

    # Force a reimport so module-level constants (DATA_DIR, DATABASE_URL) and the
    # cached engine are rebuilt from the new env.
    import app.config
    import app.db
    importlib.reload(app.config)
    importlib.reload(app.db)
    # Reset the engine singleton in case another fixture touched it.
    app.db._engine = None
    app.db._SessionLocal = None
    app.db.init_schema()
    yield
