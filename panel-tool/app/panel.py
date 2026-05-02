"""Default panel state + CT-related helpers.

The CircuitSetup 6CH+1addon board hardware fixes the port→chip mapping. Slugs
on the user's CT array are derived from the labels they enter in the UI (or
auto-filled from a stock template on first boot).
"""
from __future__ import annotations

import re
from typing import Any

# port -> (chip_id, voltage-ref index on that chip)
PORT_TO_CHIP: dict[int, tuple[str, str]] = {
    1: ("meter_1_3", "1"),
    2: ("meter_1_3", "1"),
    3: ("meter_1_3", "1"),
    4: ("meter_4_6", "2"),
    5: ("meter_4_6", "2"),
    6: ("meter_4_6", "2"),
    7: ("addon1_7_9", "1"),
    8: ("addon1_7_9", "1"),
    9: ("addon1_7_9", "1"),
    10: ("addon1_10_12", "2"),
    11: ("addon1_10_12", "2"),
    12: ("addon1_10_12", "2"),
}

CHIPS: dict[str, dict[str, Any]] = {
    "meter_1_3":    {"vsuf": "1", "label": "Meter 1–3 (mains chip)", "ports": [1, 2, 3]},
    "meter_4_6":    {"vsuf": "2", "label": "Meter 4–6",              "ports": [4, 5, 6]},
    "addon1_7_9":   {"vsuf": "1", "label": "Addon1 7–9",             "ports": [7, 8, 9]},
    "addon1_10_12": {"vsuf": "2", "label": "Addon1 10–12",           "ports": [10, 11, 12]},
}

# ESPHome's web-server entity slug uses hyphens in the chip name (because the
# upstream YAML labels them "Meter 1-3" etc.), but Home Assistant flattens those
# hyphens back to underscores when generating entity_ids. So we keep a separate
# lookup for the ESPHome-direct slug form.
CHIP_ESPHOME_SLUG: dict[str, str] = {
    "meter_1_3":    "meter_1-3",
    "meter_4_6":    "meter_4-6",
    "addon1_7_9":   "addon1_7-9",
    "addon1_10_12": "addon1_10-12",
}

CT_MODEL_CAL: dict[str, str] = {
    "SCT-013-030": "8650",
    "SCT-013-100": "8650",
    "SCT-013-000": "29600",
    "SCT-024":     "55036",  # 200A/50mA
}

CAL_BUTTONS: dict[str, tuple[str, str]] = {
    "offset_run":         ("1_run",   "_offset_cal"),
    "power_offset_run":   ("2_run",   "_power_offset_cal"),
    "gain_run":           ("3_run",   "_gain_cal"),
    "offset_clear":       ("z1_clear", "_offset_cal"),
    "power_offset_clear": ("z2_clear", "_power_offset_cal"),
    "gain_clear":         ("z3_clear", "_gain_cal"),
}

# Per-transport button slug builders. ESPHome and HA agree on underscores
# elsewhere but ESPHome doubles the separator after the leading step number
# ("1__run_meter_1-3_offset_cal") and uses hyphens in the chip slug. HA flattens
# both to single underscores ("button.<prefix>_1_run_meter_1_3_offset_cal").
def esphome_button_slug(action: str, chip_id: str) -> str:
    kind, suffix = CAL_BUTTONS[action]                  # kind = "1_run" / "z1_clear"
    step, verb = kind.split("_", 1)
    return f"{step}__{verb}_{CHIP_ESPHOME_SLUG[chip_id]}{suffix}"


def ha_button_entity(prefix: str, action: str, chip_id: str) -> str:
    kind, suffix = CAL_BUTTONS[action]
    return f"button.{prefix}_{kind}_{chip_id}{suffix}"


def slugify(label: str, port: int) -> str:
    s = label.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s or f"ct{port}"


def chip_for_port(port: int) -> tuple[str, str]:
    return PORT_TO_CHIP[port]


def _bk(pos: int, **kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "pos": pos,
        "wireLabel": "",
        "houseLabel": "",
        "amperage": 20,
        "tiedToNext": False,
        "gfci": False,
        "ctId": None,
        "notes": "",
    }
    base.update(kw)
    return base


def default_cts() -> list[dict[str, Any]]:
    """Generic CT inventory — labels are placeholders for the user to edit."""
    out = []
    for port in range(1, 13):
        if port == 1:
            label, model = "L1 Mains", "SCT-013-000"
        elif port == 2:
            label, model = "L2 Mains", "SCT-013-000"
        else:
            label, model = f"Circuit {port}", "SCT-013-030"
        out.append({
            "id": f"ct{port}",
            "slug": slugify(label, port),
            "label": label,
            "tapeLabel": "",
            "model": model,
            "port": port,
            "is240": False,
            "notes": "",
        })
    return out


def default_panel() -> dict[str, Any]:
    """Empty-ish 30-slot panel (15 left + 15 right). Users edit through the UI."""
    return {
        "cts": default_cts(),
        "left": [_bk(p) for p in range(1, 16)],
        "right": [_bk(p) for p in range(1, 16)],
    }


def normalize_panel(data: dict[str, Any]) -> dict[str, Any]:
    """Fill in any missing fields the UI expects. Tolerates older shapes."""
    if "cts" not in data:
        data["cts"] = default_cts()
    for ct in data["cts"]:
        ct.setdefault("label", "")
        ct.setdefault("tapeLabel", "")
        ct.setdefault("model", "SCT-013-030")
        ct.setdefault("port", None)
        ct.setdefault("is240", False)
        ct.setdefault("notes", "")
        if not ct.get("slug"):
            ct["slug"] = slugify(ct.get("label") or ct.get("id") or "", ct.get("port") or 0)
    for side in ("left", "right"):
        if side not in data:
            data[side] = [_bk(p) for p in range(1, 16)]
            continue
        for bk in data[side]:
            if "tied" in bk and "tiedToNext" not in bk:
                bk["tiedToNext"] = bk.pop("tied")
            bk.setdefault("tiedToNext", False)
            bk.setdefault("gfci", False)
            bk.setdefault("wireLabel", "")
            bk.setdefault("houseLabel", "")
            bk.setdefault("amperage", 20)
            bk.setdefault("ctId", None)
            bk.setdefault("notes", "")
    return data


def channels_from_panel(panel_data: dict[str, Any]) -> list[dict[str, Any]]:
    """Derive the runtime CHANNELS list (used to query the device for state)
    from the user-edited cts array."""
    by_port = {ct["port"]: ct for ct in panel_data.get("cts", []) if ct.get("port")}
    out = []
    for port in range(1, 13):
        ct = by_port.get(port)
        if not ct:
            continue
        chip, vsuf = PORT_TO_CHIP[port]
        out.append({
            "ct": port,
            "slug": ct.get("slug") or slugify(ct.get("label", ""), port),
            "chip": chip,
            "vsuf": vsuf,
            "is240": bool(ct.get("is240")),
            "label": ct.get("label", ""),
            "model": ct.get("model", ""),
        })
    return out


def yaml_export(panel_data: dict[str, Any]) -> str:
    by_port = {ct["port"]: ct for ct in panel_data.get("cts", []) if ct.get("port")}
    lines = [
        "## Generated by panel-tool",
        "## Paste into your energy_meter.yaml under `substitutions:`",
        "",
    ]
    for port in range(1, 13):
        ct = by_port.get(port)
        label = (ct.get("label") if ct else "") or f"CT{port}"
        tags = []
        if ct and ct.get("tapeLabel"):
            tags.append(f"tape={ct['tapeLabel']}")
        if ct and ct.get("model"):
            tags.append(ct["model"])
        comment = ("  # " + ", ".join(tags)) if tags else ""
        lines.append(f"  ct{port}_name: {label}{comment}")
    lines.append("")
    for port in range(1, 13):
        ct = by_port.get(port)
        cal = CT_MODEL_CAL.get(ct.get("model"), "8650") if ct else "8650"
        model = (ct.get("model") if ct else "") or "unset"
        lines.append(f"  current_cal_ct{port}: '{cal}'  # {model}")
    return "\n".join(lines)
