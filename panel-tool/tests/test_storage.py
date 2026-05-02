"""Storage-layer smoke tests."""
from __future__ import annotations


def test_panel_default_is_persisted_round_trip():
    from app import db
    from app import panel as pm
    db.save_panel(pm.default_panel())
    loaded = db.load_panel()
    assert loaded is not None
    assert len(loaded["cts"]) == 12
    assert len(loaded["left"]) == 15
    assert len(loaded["right"]) == 15


def test_setting_plain_round_trip():
    from app import db
    db.set_setting("esphome_url", "http://example.test")
    assert db.get_setting("esphome_url") == "http://example.test"
    assert db.is_configured()


def test_setting_secret_is_encrypted_at_rest():
    from app import db
    db.set_setting("ha_token", "super-secret")
    assert db.get_setting("ha_token") == "super-secret"
    # Inspect the raw row — the on-disk value should not equal the plaintext.
    with db.session() as s:
        row = s.get(db.AppSetting, "ha_token")
        assert row is not None
        assert row.is_secret == 1
        assert row.value != "super-secret"


def test_normalize_panel_fills_defaults_for_missing_fields():
    from app import panel as pm
    minimal = {"cts": [{"port": 1, "label": "L1 Mains"}], "left": [{"pos": 1}], "right": [{"pos": 1}]}
    out = pm.normalize_panel(minimal)
    assert out["cts"][0]["model"] == "SCT-013-030"
    assert out["cts"][0]["slug"] == "l1_mains"
    assert out["left"][0]["amperage"] == 20
    assert out["left"][0]["tiedToNext"] is False


def test_yaml_export_uses_correct_cal_for_model():
    from app import panel as pm
    data = pm.default_panel()
    data["cts"][0]["model"] = "SCT-024"  # mains
    out = pm.yaml_export(data)
    assert "current_cal_ct1: '55036'" in out


def test_chip_for_port_mapping():
    from app import panel as pm
    assert pm.chip_for_port(1) == ("meter_1_3", "1")
    assert pm.chip_for_port(6) == ("meter_4_6", "2")
    assert pm.chip_for_port(7) == ("addon1_7_9", "1")
    assert pm.chip_for_port(12) == ("addon1_10_12", "2")
