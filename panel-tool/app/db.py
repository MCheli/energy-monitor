"""Storage layer — SQLAlchemy 2.x, sync.

Two tables:
  - panel_state: a single row holding the current panel JSON blob (cts, left, right).
  - app_settings: key/value runtime configuration (esphome URL, HA token, etc.).
    Sensitive values are encrypted at rest with a Fernet key derived from
    config.SECRET_KEY.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Integer,
    String,
    Text,
    create_engine,
    select,
)
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from . import config

log = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


class PanelState(Base):
    __tablename__ = "panel_state"
    id = Column(Integer, primary_key=True)
    data = Column(JSON, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class AppSetting(Base):
    __tablename__ = "app_settings"
    key = Column(String(64), primary_key=True)
    value = Column(Text, nullable=False, default="")
    is_secret = Column(Integer, nullable=False, default=0)  # 0/1 — secret values stored as Fernet ciphertext
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


_engine = None
_SessionLocal: sessionmaker | None = None


def engine():
    global _engine, _SessionLocal
    if _engine is None:
        url = config.DATABASE_URL
        connect_args = {}
        if url.startswith("sqlite"):
            # check_same_thread=False because http.server may serve sequential
            # requests from different threads but never concurrently for one
            # connection.
            connect_args["check_same_thread"] = False
            # Make sure the parent directory exists for sqlite:///path/to/db.sqlite.
            from urllib.parse import urlparse
            parsed = urlparse(url)
            if parsed.path and parsed.path != "/:memory:":
                # SQLAlchemy's sqlite URLs have the form sqlite:///abs/path
                # → urlparse gives path="/abs/path"; lstrip just one slash for
                # relative form sqlite:///./relative/path.
                from pathlib import Path as _P
                _P(parsed.path).parent.mkdir(parents=True, exist_ok=True)
        _engine = create_engine(url, connect_args=connect_args, future=True)
        _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine


@contextmanager
def session() -> Iterator[Session]:
    engine()  # ensure initialized
    s = _SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def init_schema() -> None:
    """Create tables if they don't exist. Idempotent.

    For Postgres deployments Alembic owns the schema (the entrypoint runs
    `alembic upgrade head` before this is called). Calling create_all() on top
    is harmless — it's a no-op when the schema is already present.
    """
    Base.metadata.create_all(engine())


# ---------------------------------------------------------------------------
# Panel state
# ---------------------------------------------------------------------------

def load_panel() -> dict[str, Any] | None:
    with session() as s:
        row = s.get(PanelState, 1)
        if row is None:
            return None
        return row.data


def save_panel(data: dict[str, Any]) -> None:
    with session() as s:
        row = s.get(PanelState, 1)
        if row is None:
            s.add(PanelState(id=1, data=data))
        else:
            row.data = data


# ---------------------------------------------------------------------------
# Settings (encrypted at rest for secrets)
# ---------------------------------------------------------------------------

def _fernet() -> Fernet | None:
    if not config.SECRET_KEY:
        return None
    # Derive a 32-byte key from SECRET_KEY deterministically.
    digest = hashlib.sha256(config.SECRET_KEY.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _encrypt(value: str) -> str:
    f = _fernet()
    if f is None:
        # No SECRET_KEY → store plaintext but mark in logs. Suitable for
        # local-only dev; the deployment guide requires SECRET_KEY in production.
        log.warning("SECRET_KEY not set; storing secret value in plaintext")
        return value
    return f.encrypt(value.encode()).decode()


def _decrypt(value: str) -> str:
    f = _fernet()
    if f is None:
        return value
    try:
        return f.decrypt(value.encode()).decode()
    except InvalidToken:
        # Either SECRET_KEY rotated, or the value was stored unencrypted.
        # Return empty so the UI prompts re-entry rather than crashing.
        log.warning("Failed to decrypt setting; returning empty (key rotated or value not encrypted)")
        return ""


# Keys we know about. Anything else passed to set_setting() will be stored too;
# this list is just the canonical set for documentation + the setup page.
KNOWN_SETTINGS: dict[str, dict[str, Any]] = {
    "esphome_url":   {"label": "ESPHome device URL",     "secret": False, "required": True,
                      "help": "Direct URL to the meter's ESPHome web server, e.g. http://192.168.1.50 or http://energy-meter.local"},
    "device_prefix": {"label": "HA entity prefix",       "secret": False, "required": False,
                      "help": "Optional. Only needed if you query through Home Assistant. Look at any meter sensor in HA — the part before '_voltage_1'."},
    "ha_url":        {"label": "Home Assistant URL",     "secret": False, "required": False,
                      "help": "Optional. e.g. http://homeassistant.local:8123. Leave blank to query the meter directly."},
    "ha_token":      {"label": "HA long-lived token",    "secret": True,  "required": False,
                      "help": "Optional. Generate at HA → Profile → Long-Lived Access Tokens."},
    "voltage_default": {"label": "Default reference voltage", "secret": False, "required": False,
                        "help": "Used to seed cal wizards. 119.5 for North America, 230 for most of Europe."},
    "esphome_yaml": {"label": "ESPHome YAML (paste your energy_meter.yaml)", "secret": False, "required": False,
                     "help": "Optional. Paste your full energy_meter.yaml so the dashboard can show the boot-time current_cal_ctN, voltage_calN, and power-filter multipliers. Stored verbatim; re-paste after firmware changes."},
}


# ---------------------------------------------------------------------------
# Parsing of the user's pasted ESPHome YAML for cal-display data.
# ---------------------------------------------------------------------------

def yaml_cal_constants() -> dict[str, dict[str, Any]]:
    """Pull the static cal-display data from the user's pasted YAML.

    Returns {"yamlCal": {port: cal_str, ...}, "yamlVoltCal": {1: cal, 2: cal},
             "yamlPowerMult": {port: int, ...}}. Any of the three sub-dicts may
    be empty if the YAML wasn't pasted or the regex didn't match.
    """
    import re
    text = get_setting("esphome_yaml")
    out = {"yamlCal": {}, "yamlVoltCal": {}, "yamlPowerMult": {p: 1 for p in range(1, 13)}}
    if not text:
        return out
    for m in re.finditer(r"current_cal_ct(\d+):\s*['\"]?(\d+)['\"]?", text):
        out["yamlCal"][int(m.group(1))] = m.group(2)
    for m in re.finditer(r"voltage_cal(\d):\s*['\"]?(\d+)['\"]?", text):
        out["yamlVoltCal"][int(m.group(1))] = m.group(2)
    chip_phase_to_ct = {
        "meter_main1": {"a": 1, "b": 2, "c": 3},
        "meter_main2": {"a": 4, "b": 5, "c": 6},
        "addon1_1":    {"a": 7, "b": 8, "c": 9},
        "addon1_2":    {"a": 10, "b": 11, "c": 12},
    }
    for chip_id, phase_to_ct in chip_phase_to_ct.items():
        block_pat = rf"id:\s*!extend\s+{re.escape(chip_id)}\b(.*?)(?=\n-\s+id:\s*!extend|\Z)"
        bm = re.search(block_pat, text, re.DOTALL)
        if not bm:
            continue
        block = bm.group(1)
        for phase, ct_num in phase_to_ct.items():
            phase_pat = rf"phase_{phase}:\s*\n\s*power:\s*\n\s*filters:\s*\[multiply:\s*(-?\d+)\s*\]"
            pm = re.search(phase_pat, block)
            if pm:
                out["yamlPowerMult"][ct_num] = int(pm.group(1))
    return out


def get_setting(key: str, default: str = "") -> str:
    with session() as s:
        row = s.get(AppSetting, key)
        if row is None:
            return default
        return _decrypt(row.value) if row.is_secret else row.value


def set_setting(key: str, value: str) -> None:
    is_secret = bool(KNOWN_SETTINGS.get(key, {}).get("secret"))
    stored = _encrypt(value) if is_secret else value
    with session() as s:
        row = s.get(AppSetting, key)
        if row is None:
            s.add(AppSetting(key=key, value=stored, is_secret=int(is_secret)))
        else:
            row.value = stored
            row.is_secret = int(is_secret)


def all_settings() -> dict[str, str]:
    """Return all known settings (decrypted), for use by handlers/UI."""
    out: dict[str, str] = {}
    with session() as s:
        rows = s.execute(select(AppSetting)).scalars().all()
        for r in rows:
            out[r.key] = _decrypt(r.value) if r.is_secret else r.value
    return out


def is_configured() -> bool:
    """True iff the minimum-required settings have been entered."""
    return bool(get_setting("esphome_url"))


# ---------------------------------------------------------------------------
# Calibration press log
#
# ESPHome's web server treats button presses as fire-and-forget — there's no
# `last_changed` to query. So we keep our own log: a single JSON value in
# app_settings under `cal_press_log`, mapping "{chip_id}.{action}" to the
# UTC ISO timestamp when /api/cal/press last fired it. This means lastChanged
# values populate even on the ESPHome-direct transport.
# ---------------------------------------------------------------------------

_CAL_LOG_KEY = "cal_press_log"


def record_cal_press(chip_id: str, action: str) -> str:
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    raw = get_setting(_CAL_LOG_KEY) or "{}"
    try:
        log_data = json.loads(raw)
    except json.JSONDecodeError:
        log_data = {}
    log_data[f"{chip_id}.{action}"] = ts
    set_setting(_CAL_LOG_KEY, json.dumps(log_data))
    return ts


def get_cal_press_log() -> dict[str, str]:
    raw = get_setting(_CAL_LOG_KEY) or "{}"
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}
