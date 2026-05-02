"""Tests for the YAML export — merge logic + zip + endpoints."""
from __future__ import annotations

import io
import json
import socket
import threading
import time
import urllib.request
import zipfile
from contextlib import closing
from http.server import HTTPServer

import pytest


def _free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def server():
    from app.server import Handler
    port = _free_port()
    httpd = HTTPServer(("127.0.0.1", port), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"
    time.sleep(0.05)
    yield base
    httpd.shutdown()
    httpd.server_close()


def _post(base: str, path: str, payload: dict) -> tuple[int, dict]:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(f"{base}{path}", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    r = urllib.request.urlopen(req)
    return r.status, json.loads(r.read())


def _get_bytes(base: str, path: str) -> tuple[int, dict, bytes]:
    r = urllib.request.urlopen(f"{base}{path}")
    return r.status, dict(r.headers), r.read()


# ---- Merge logic ----------------------------------------------------------

def test_merge_skeleton_when_no_stored_yaml():
    from app import db, panel as pm, yaml_export as ye
    db.save_panel(pm.default_panel())
    out = ye.merge_full_yaml(db.load_panel())
    assert "substitutions:" in out
    assert "ct1_name: L1 Mains" in out
    assert "esphome:" in out
    # The skeleton must NOT escape the YAML's own ${...} placeholders.
    assert "${disp_name}" in out
    assert "${friendly_name}" in out


def test_merge_replaces_ct_names_in_stored_yaml():
    from app import db, panel as pm, yaml_export as ye
    db.set_setting("esphome_yaml", """\
substitutions:
  disp_name: example
  ct1_name: Old L1 Name
  ct3_name: Old Fridge Name
  current_cal_ct1: '12345'
  voltage_cal1: '7305'

esphome:
  name: example
""")
    data = pm.default_panel()
    data["cts"][0]["label"] = "My L1 Mains"
    data["cts"][0]["model"] = "SCT-024"
    data["cts"][2]["label"] = "Coffee Maker"
    db.save_panel(data)

    out = ye.merge_full_yaml(db.load_panel())
    assert "ct1_name: My L1 Mains" in out
    assert "ct3_name: Coffee Maker" in out
    assert "current_cal_ct1: '55036'" in out  # SCT-024 → 55036
    # Things we didn't touch must survive verbatim:
    assert "voltage_cal1: '7305'" in out
    assert "disp_name: example" in out


def test_merge_appends_missing_keys_to_substitutions_block():
    from app import db, panel as pm, yaml_export as ye
    # YAML has substitutions but is missing ct5_name entirely.
    db.set_setting("esphome_yaml", """\
substitutions:
  disp_name: example
  ct1_name: L1 Mains

esphome:
  name: example
""")
    db.save_panel(pm.default_panel())
    out = ye.merge_full_yaml(db.load_panel())
    # ct5_name was missing; should now appear before the esphome: section.
    sub_idx = out.index("substitutions:")
    esphome_idx = out.index("esphome:")
    sub_block = out[sub_idx:esphome_idx]
    assert "ct5_name:" in sub_block


def test_merge_is_idempotent():
    from app import db, panel as pm, yaml_export as ye
    db.set_setting("esphome_yaml", """\
substitutions:
  ct1_name: foo
  current_cal_ct1: '1'
""")
    db.save_panel(pm.default_panel())
    once = ye.merge_full_yaml(db.load_panel())
    db.set_setting("esphome_yaml", once)
    twice = ye.merge_full_yaml(db.load_panel())
    assert once == twice


# ---- Zip ------------------------------------------------------------------

def test_zip_contains_three_files():
    from app import db, panel as pm, yaml_export as ye
    db.save_panel(pm.default_panel())
    blob = ye.build_zip_bytes(db.load_panel())
    zf = zipfile.ZipFile(io.BytesIO(blob))
    names = set(zf.namelist())
    assert names == {"energy_meter.yaml", "secrets.yaml.example", "README.md"}
    yaml_text = zf.read("energy_meter.yaml").decode()
    assert "substitutions:" in yaml_text
    secrets_text = zf.read("secrets.yaml.example").decode()
    assert "wifi_ssid" in secrets_text
    readme_text = zf.read("README.md").decode()
    assert "esphome run" in readme_text.lower()


# ---- HTTP endpoints --------------------------------------------------------

def test_endpoint_export_status_unconfigured(server: str) -> None:
    code, _, body = _get_bytes(server, "/api/export/status")
    assert code == 200
    assert json.loads(body) == {"yamlPresent": False}


def test_endpoint_export_status_after_paste(server: str) -> None:
    _post(server, "/api/settings", {"esphome_url": "http://x", "esphome_yaml": "substitutions:\n  ct1_name: x\n"})
    code, _, body = _get_bytes(server, "/api/export/status")
    assert code == 200 and json.loads(body) == {"yamlPresent": True}


def test_endpoint_snippet_download_headers(server: str) -> None:
    code, headers, body = _get_bytes(server, "/api/export/snippet")
    assert code == 200
    assert "substitutions.yaml" in headers.get("Content-Disposition", "")
    assert b"current_cal_ct" in body


def test_endpoint_full_download_returns_yaml(server: str) -> None:
    code, headers, body = _get_bytes(server, "/api/export/full")
    assert code == 200
    assert "energy_meter.yaml" in headers.get("Content-Disposition", "")
    text = body.decode()
    assert "substitutions:" in text
    assert "esphome:" in text


def test_endpoint_zip_download_returns_valid_zip(server: str) -> None:
    code, headers, body = _get_bytes(server, "/api/export/zip")
    assert code == 200
    assert headers.get("Content-Type") == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(body))
    assert set(zf.namelist()) == {"energy_meter.yaml", "secrets.yaml.example", "README.md"}
