"""Credentials in DATABASE_URL must never reach the logs, and a plain
postgresql:// URL must resolve to the psycopg2 driver the image ships."""
from __future__ import annotations

import importlib
import logging

import pytest

from app import config


@pytest.mark.parametrize("password", ["s3cret", "p@ss/w:rd", "a%40b%2Fc", "x" * 40])
def test_redact_url_hides_password(password):
    url = f"postgresql+psycopg2://panel:{password}@db:5432/panel"
    out = config.redact_url(url)
    assert password not in out
    assert "***" in out
    assert "db:5432/panel" in out


def test_redact_url_unparseable_does_not_echo_input():
    out = config.redact_url("not a url :: hunter2")
    assert "hunter2" not in out


@pytest.mark.parametrize("scheme", ["postgresql", "postgres"])
def test_plain_postgres_url_pins_psycopg2(monkeypatch, scheme):
    monkeypatch.setenv("DATABASE_URL", f"{scheme}://u:p@db/x")
    importlib.reload(config)
    assert config.DATABASE_URL == "postgresql+psycopg2://u:p@db/x"


def test_startup_log_has_no_password(monkeypatch, caplog):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:topsecret@db/x")
    importlib.reload(config)
    from app import server

    class _Stop(Exception):
        pass

    def _boom(*a, **k):
        raise _Stop

    monkeypatch.setattr(server.db, "init_schema", lambda: None)
    monkeypatch.setattr(server, "HTTPServer", _boom)
    with caplog.at_level(logging.INFO), pytest.raises(_Stop):
        server.serve()
    assert "topsecret" not in caplog.text
    assert "db/x" in caplog.text
