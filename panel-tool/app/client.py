"""Device client — talks to either the ESPHome web server directly, or a Home
Assistant instance acting as a proxy.

The ESPHome path requires only an ESPHome URL (no token). The HA path needs
HA URL + long-lived token + device entity prefix.

Both paths expose the same surface: fetch_state(), set_ref_v(), set_ref_current(),
press_cal_button().
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any

from . import db
from . import panel as panel_mod

UA = "panel-tool/1.0"
TIMEOUT_SHORT = 5
TIMEOUT_LONG = 8


class DeviceError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Settings access
# ---------------------------------------------------------------------------

def _settings() -> dict[str, str]:
    return {
        "esphome_url":   db.get_setting("esphome_url"),
        "ha_url":        db.get_setting("ha_url"),
        "ha_token":      db.get_setting("ha_token"),
        "device_prefix": db.get_setting("device_prefix"),
    }


def transport_mode(s: dict[str, str] | None = None) -> str:
    s = s or _settings()
    if s["ha_url"] and s["ha_token"] and s["device_prefix"]:
        return "homeassistant"
    if s["esphome_url"]:
        return "esphome"
    return "unconfigured"


# ---------------------------------------------------------------------------
# Low-level HTTP
# ---------------------------------------------------------------------------

def _http(method: str, url: str, *, headers: dict[str, str] | None = None,
          body: bytes | None = None, timeout: int = TIMEOUT_SHORT) -> bytes:
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except Exception as e:
        raise DeviceError(f"{method} {url}: {e}") from e


# ---------------------------------------------------------------------------
# ESPHome direct
# ---------------------------------------------------------------------------

def _esphome_get_json(base: str, path: str) -> Any:
    raw = _http("GET", f"{base.rstrip('/')}{path}")
    return json.loads(raw)


def _esphome_set_number(base: str, slug: str, value: float) -> None:
    q = urllib.parse.urlencode({"value": value})
    _http("POST", f"{base.rstrip('/')}/number/{slug}/set?{q}", body=b"")


def _esphome_press_button(base: str, slug: str) -> None:
    _http("POST", f"{base.rstrip('/')}/button/{slug}/press", body=b"")


def _esphome_fetch_state(base: str, panel_data: dict[str, Any]) -> dict[str, Any]:
    """Read every entity from the device via its ESPHome web server.

    ESPHome chip-level entities use a hyphenated slug ("meter_1-3" not
    "meter_1_3"). We use panel.CHIP_ESPHOME_SLUG to translate.
    """
    channels = panel_mod.channels_from_panel(panel_data)
    press_log = db.get_cal_press_log()
    out: dict[str, Any] = {
        "channels": [],
        "byPort": {},
        "byChip": {},
        "voltage1": None,
        "freq": None,
        "uptime": None,
        "resetReason": None,
        "totalWatts": None,
        "totalAmps": None,
        "transport": "esphome",
    }

    def safe_state(path: str) -> Any:
        try:
            return _esphome_get_json(base, path).get("value")
        except Exception:
            return None

    out["voltage1"] = safe_state("/sensor/voltage_1")
    out["freq"] = safe_state("/sensor/frequency_1")

    for ch in channels:
        slug = ch["slug"]
        amps = safe_state(f"/sensor/{slug}_amps")
        watts = safe_state(f"/sensor/{slug}_watts")
        ref_i = safe_state(f"/number/{slug}_ref_current")
        chip_es_slug = panel_mod.CHIP_ESPHOME_SLUG[ch["chip"]]
        ref_v = safe_state(f"/number/{chip_es_slug}_ref_v_{ch['vsuf']}")
        port_data = {
            "port": ch["ct"], "slug": slug, "chip": ch["chip"], "vsuf": ch["vsuf"],
            "is240": ch["is240"],
            "amps": amps, "watts": watts,
            "refCurrent": ref_i, "refCurrentChanged": None,
            "refV": ref_v, "refVChanged": None,
            "status": None,
        }
        out["channels"].append(port_data)
        out["byPort"][ch["ct"]] = port_data

    for chip_id, meta in panel_mod.CHIPS.items():
        chip_es_slug = panel_mod.CHIP_ESPHOME_SLUG[chip_id]
        cal_buttons = {}
        for action in panel_mod.CAL_BUTTONS:
            cal_buttons[action] = {
                "state": None,
                "lastChanged": press_log.get(f"{chip_id}.{action}"),
            }
        out["byChip"][chip_id] = {
            "id": chip_id,
            "label": meta["label"],
            "ports": meta["ports"],
            "vsuf": meta["vsuf"],
            "chipTemp": safe_state(f"/sensor/{chip_es_slug}_chip_temp"),
            "refV": safe_state(f"/number/{chip_es_slug}_ref_v_{meta['vsuf']}"),
            "refVChanged": None,
            "buttons": cal_buttons,
        }
    out["chipMeta"] = panel_mod.CHIPS
    return out


# ---------------------------------------------------------------------------
# Home Assistant
# ---------------------------------------------------------------------------

def _ha_get_states(ha_url: str, ha_token: str) -> dict[str, Any]:
    raw = _http("GET", f"{ha_url.rstrip('/')}/api/states",
                headers={"Authorization": f"Bearer {ha_token}"},
                timeout=TIMEOUT_LONG)
    return {s["entity_id"]: s for s in json.loads(raw)}


def _ha_post_service(ha_url: str, ha_token: str, domain: str, service: str, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode()
    _http("POST", f"{ha_url.rstrip('/')}/api/services/{domain}/{service}",
          headers={"Authorization": f"Bearer {ha_token}", "Content-Type": "application/json"},
          body=body)


def _ha_fetch_state(s: dict[str, str], panel_data: dict[str, Any]) -> dict[str, Any]:
    states = _ha_get_states(s["ha_url"], s["ha_token"])
    prefix = s["device_prefix"]
    channels = panel_mod.channels_from_panel(panel_data)
    out: dict[str, Any] = {
        "channels": [], "byPort": {}, "byChip": {},
        "voltage1": None, "freq": None, "uptime": None, "resetReason": None,
        "totalWatts": None, "totalAmps": None,
        "transport": "homeassistant",
    }

    def state(eid: str, key: str = "state") -> Any:
        return states.get(eid, {}).get(key)

    out["voltage1"] = state(f"sensor.{prefix}_voltage_1")
    out["freq"] = state(f"sensor.{prefix}_frequency_1")
    out["uptime"] = state(f"sensor.{prefix}_uptime")
    out["resetReason"] = state(f"sensor.{prefix}_reset_reason")
    out["totalWatts"] = state(f"sensor.{prefix}_energy_meter_total_watts")
    out["totalAmps"] = state(f"sensor.{prefix}_energy_meter_total_amps")

    for ch in channels:
        slug = ch["slug"]
        amps = state(f"sensor.{prefix}_{slug}_amps")
        watts = state(f"sensor.{prefix}_{slug}_watts")
        ref_i = state(f"number.{prefix}_{slug}_ref_current")
        ref_i_changed = state(f"number.{prefix}_{slug}_ref_current", "last_changed")
        ref_v = state(f"number.{prefix}_{ch['chip']}_ref_v_{ch['vsuf']}")
        ref_v_changed = state(f"number.{prefix}_{ch['chip']}_ref_v_{ch['vsuf']}", "last_changed")
        status = state(f"sensor.{prefix}_{slug}_status")
        port_data = {
            "port": ch["ct"], "slug": slug, "chip": ch["chip"], "vsuf": ch["vsuf"],
            "is240": ch["is240"],
            "amps": amps, "watts": watts,
            "refCurrent": ref_i, "refCurrentChanged": ref_i_changed,
            "refV": ref_v, "refVChanged": ref_v_changed,
            "status": status,
        }
        out["channels"].append(port_data)
        out["byPort"][ch["ct"]] = port_data

    for chip_id, meta in panel_mod.CHIPS.items():
        chip_temp = state(f"sensor.{prefix}_{chip_id}_chip_temp")
        ref_v_state = state(f"number.{prefix}_{chip_id}_ref_v_{meta['vsuf']}")
        ref_v_changed = state(f"number.{prefix}_{chip_id}_ref_v_{meta['vsuf']}", "last_changed")
        cal_buttons = {}
        for action, (kind, suffix) in panel_mod.CAL_BUTTONS.items():
            ent = states.get(f"button.{prefix}_{kind}_{chip_id}{suffix}", {})
            cal_buttons[action] = {"state": ent.get("state"), "lastChanged": ent.get("last_changed")}
        out["byChip"][chip_id] = {
            "id": chip_id, "label": meta["label"], "ports": meta["ports"], "vsuf": meta["vsuf"],
            "chipTemp": chip_temp, "refV": ref_v_state, "refVChanged": ref_v_changed,
            "buttons": cal_buttons,
        }
    out["chipMeta"] = panel_mod.CHIPS
    return out


# ---------------------------------------------------------------------------
# Public surface — picks transport based on settings
# ---------------------------------------------------------------------------

def fetch_state(panel_data: dict[str, Any]) -> dict[str, Any]:
    s = _settings()
    mode = transport_mode(s)
    if mode == "homeassistant":
        out = _ha_fetch_state(s, panel_data)
    elif mode == "esphome":
        out = _esphome_fetch_state(s["esphome_url"], panel_data)
    else:
        raise DeviceError("Device not configured. Visit /setup to enter your meter URL.")
    # Augment with YAML-derived cal-display data, if the user pasted their YAML.
    out.update(db.yaml_cal_constants())
    return out


def set_ref_v(chip: str, vsuf: str, value: float) -> str:
    s = _settings()
    mode = transport_mode(s)
    if mode == "homeassistant":
        eid = f"number.{s['device_prefix']}_{chip}_ref_v_{vsuf}"
        _ha_post_service(s["ha_url"], s["ha_token"], "number", "set_value",
                         {"entity_id": eid, "value": value})
        return eid
    if mode == "esphome":
        slug = f"{panel_mod.CHIP_ESPHOME_SLUG[chip]}_ref_v_{vsuf}"
        _esphome_set_number(s["esphome_url"], slug, value)
        return slug
    raise DeviceError("Device not configured.")


def set_ref_current(slug: str, value: float) -> str:
    s = _settings()
    mode = transport_mode(s)
    if mode == "homeassistant":
        eid = f"number.{s['device_prefix']}_{slug}_ref_current"
        _ha_post_service(s["ha_url"], s["ha_token"], "number", "set_value",
                         {"entity_id": eid, "value": value})
        return eid
    if mode == "esphome":
        target = f"{slug}_ref_current"
        _esphome_set_number(s["esphome_url"], target, value)
        return target
    raise DeviceError("Device not configured.")


def press_cal_button(action: str, chip: str) -> str:
    if action not in panel_mod.CAL_BUTTONS:
        raise ValueError(f"Unknown cal action: {action}")
    s = _settings()
    mode = transport_mode(s)
    if mode == "homeassistant":
        eid = panel_mod.ha_button_entity(s["device_prefix"], action, chip)
        _ha_post_service(s["ha_url"], s["ha_token"], "button", "press",
                         {"entity_id": eid})
        db.record_cal_press(chip, action)
        return eid
    if mode == "esphome":
        slug = panel_mod.esphome_button_slug(action, chip)
        _esphome_press_button(s["esphome_url"], slug)
        db.record_cal_press(chip, action)
        return slug
    raise DeviceError("Device not configured.")
