"""HTTP-layer smoke tests — boot the server in a thread, hit it with urllib."""
from __future__ import annotations

import json
import socket
import threading
import time
import urllib.request
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
    # Tiny grace period for the listener to come up.
    time.sleep(0.05)
    yield base
    httpd.shutdown()
    httpd.server_close()


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def http_error_302(self, req, fp, code, msg, headers): raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)
    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


def _get(base: str, path: str, *, allow_redirects: bool = False) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(f"{base}{path}")
    opener = urllib.request.build_opener(_NoRedirectHandler) if not allow_redirects else urllib.request.build_opener()
    try:
        r = opener.open(req)
        return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.status, dict(e.headers), e.read()


def _post(base: str, path: str, payload: dict) -> tuple[int, dict]:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(f"{base}{path}", data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        r = urllib.request.urlopen(req)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.status, json.loads(e.read() or b"{}")


def test_health(server: str) -> None:
    code, _, body = _get(server, "/api/health")
    assert code == 200
    assert json.loads(body) == {"ok": True}


def test_unconfigured_root_redirects_to_setup(server: str) -> None:
    code, headers, _ = _get(server, "/")
    assert code == 303
    assert headers.get("Location") == "/setup"


def test_setup_page_is_always_reachable(server: str) -> None:
    code, _, body = _get(server, "/setup")
    assert code == 200
    assert b"<form id=\"setup-form\"" in body


def test_settings_round_trip_with_redaction(server: str) -> None:
    code, data = _post(server, "/api/settings", {"esphome_url": "http://meter.local", "ha_token": "tok-xyz"})
    assert code == 200
    assert data["configured"] is True

    code, _, body = _get(server, "/api/settings")
    assert code == 200
    settings = json.loads(body)
    assert settings["esphome_url"] == "http://meter.local"
    # ha_token is a secret — it must NOT be returned in plaintext.
    assert settings["ha_token"] == "__set__"


def test_root_serves_index_after_configure(server: str) -> None:
    _post(server, "/api/settings", {"esphome_url": "http://meter.local"})
    code, _, body = _get(server, "/")
    assert code == 200
    assert b"<title>Energy Monitor Panel Tool</title>" in body


def test_panel_default_returned_when_db_empty(server: str) -> None:
    code, _, body = _get(server, "/api/panel")
    assert code == 200
    p = json.loads(body)
    assert len(p["cts"]) == 12 and len(p["left"]) == 15 and len(p["right"]) == 15


def test_panel_save_and_reload(server: str) -> None:
    _, original = _post(server, "/api/panel", {})  # writes default-after-normalize
    code, data = _post(server, "/api/panel", {
        "cts": [{"port": 1, "label": "L1 Mains", "model": "SCT-024"}],
        "left": [{"pos": 1, "wireLabel": "Test"}],
        "right": [{"pos": 1}],
    })
    assert code == 200 and data["ok"] is True
    code, _, body = _get(server, "/api/panel")
    p = json.loads(body)
    assert p["left"][0]["wireLabel"] == "Test"
    assert p["cts"][0]["model"] == "SCT-024"


def test_state_endpoint_says_unconfigured_with_502(server: str) -> None:
    # Without esphome_url set the device client will refuse.
    code, _, body = _get(server, "/api/state")
    assert code == 502
    assert b"not configured" in body.lower()
