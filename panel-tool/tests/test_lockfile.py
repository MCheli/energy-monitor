"""Guard: rebuilds must not drift. requirements.txt is installed with --no-deps, so every
runtime package has to be pinned there, and the Postgres driver and SQLAlchemy cap that
the 2026-10-31 crash-loop taught us about must stay in place."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIN = re.compile(r"^([A-Za-z0-9._-]+)==([^\s;]+)$")


def _lockfile():
    pins = {}
    for line in (ROOT / "requirements.txt").read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        m = PIN.match(line)
        assert m, f"requirements.txt line is not an exact pin: {line!r}"
        pins[m.group(1).lower().replace("_", "-")] = m.group(2)
    return pins


def test_every_lockfile_entry_is_pinned():
    assert _lockfile()


def test_postgres_driver_is_locked():
    assert "psycopg2-binary" in _lockfile()


def test_sqlalchemy_stays_below_2_1():
    major, minor = (int(x) for x in _lockfile()["sqlalchemy"].split(".")[:2])
    assert (major, minor) < (2, 1)


def test_direct_dependencies_are_capped():
    for line in (ROOT / "requirements.in").read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            assert "<" in line or "==" in line, f"requirements.in entry has no upper bound: {line!r}"
