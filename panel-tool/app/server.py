"""HTTP server — uses the stdlib http.server. Single-threaded, simple, no deps.

Routes:
  GET  /                       static index.html (panel UI)
  GET  /setup                  static setup.html (first-run / settings)
  GET  /static/*               static assets
  GET  /api/health             liveness + DB ping
  GET  /api/config-status      whether the app has been set up
  GET  /api/settings           current runtime settings (secrets redacted)
  POST /api/settings           update runtime settings
  GET  /api/panel              load panel state
  POST /api/panel              save panel state
  GET  /api/state              live state from the meter
  GET  /api/full               panel + live state combined
  GET  /api/yaml-export        ESPHome substitutions snippet
  POST /api/log                append a line to panel.log on disk
  POST /api/snapshot           write a JSON snapshot to disk
  POST /api/cal/set-ref-v      set reference voltage on a chip
  POST /api/cal/set-ref-current set reference current on a slug
  POST /api/cal/press          press a calibration button
"""
from __future__ import annotations

import base64
import json
import logging
import os
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

from . import client, config, db, yaml_export
from . import panel as panel_mod

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg":  "image/svg+xml",
    ".png":  "image/png",
    ".ico":  "image/x-icon",
}


def _data_subpath(*parts: str) -> Path:
    p = config.DATA_DIR.joinpath(*parts)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _append_log(msg: str) -> None:
    ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    log_path = _data_subpath("panel.log")
    with log_path.open("a") as f:
        f.write(f"{ts}  {msg}\n")


def _write_snapshot(panel_data: dict[str, Any], live: dict[str, Any]) -> str:
    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    path = _data_subpath("snapshots", f"{ts}.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"timestamp": ts, "panel": panel_data, "live": live}
    path.write_text(json.dumps(payload, indent=2))
    return path.name


def _settings_for_ui() -> dict[str, Any]:
    """All known settings, with secret values redacted to a placeholder so the
    UI knows whether something is set without exposing it."""
    raw = db.all_settings()
    out: dict[str, Any] = {"_meta": db.KNOWN_SETTINGS, "_transport": client.transport_mode()}
    for key, meta in db.KNOWN_SETTINGS.items():
        val = raw.get(key, "")
        if meta["secret"] and val:
            out[key] = "__set__"   # sentinel telling the UI "value present, hidden"
        else:
            out[key] = val
    return out


def _load_panel_or_default() -> dict[str, Any]:
    data = db.load_panel()
    if data is None:
        data = panel_mod.default_panel()
        db.save_panel(data)
        return data
    return panel_mod.normalize_panel(data)


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "panel-tool/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:  # quiet by default
        if os.environ.get("PANEL_TOOL_LOG_REQUESTS") == "1":
            super().log_message(fmt, *args)

    # ---- helpers --------------------------------------------------------

    def _check_basic_auth(self) -> bool:
        if not config.BASIC_AUTH:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:]).decode()
        except Exception:
            return False
        return decoded == config.BASIC_AUTH

    def _send(self, code: int, body: Any, content_type: str = "application/json",
              extra_headers: dict[str, str] | None = None) -> None:
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Any:
        n = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(n) or b"{}")

    def _serve_static(self, name: str) -> None:
        path = (STATIC_DIR / name).resolve()
        try:
            path.relative_to(STATIC_DIR.resolve())
        except ValueError:
            return self._send(403, {"error": "forbidden"})
        if not path.exists() or path.is_dir():
            return self._send(404, {"error": "not found"})
        ct = STATIC_TYPES.get(path.suffix.lower(), "application/octet-stream")
        self._send(200, path.read_bytes(), ct)

    def _redirect(self, location: str) -> None:
        body = b""
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()
        self.wfile.write(body)

    # ---- routing --------------------------------------------------------

    def _ok_auth(self) -> bool:
        if self._check_basic_auth():
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="panel-tool"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def do_GET(self) -> None:
        if not self._ok_auth():
            return
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/health":
                # Light sanity check — DB reachable + schema present.
                with db.session() as s:
                    s.execute(db.select(db.AppSetting).limit(1))
                return self._send(200, {"ok": True})
            if path == "/api/config-status":
                return self._send(200, {"configured": db.is_configured(), "transport": client.transport_mode()})
            if path == "/api/settings":
                return self._send(200, _settings_for_ui())

            # First-run gate: until configured, redirect HTML routes to /setup.
            if not db.is_configured() and path in ("/", "/index.html"):
                return self._redirect("/setup")

            if path in ("/", "/index.html"):
                return self._serve_static("index.html")
            if path == "/setup":
                return self._serve_static("setup.html")
            if path.startswith("/static/"):
                return self._serve_static(path[len("/static/"):])

            if path == "/api/panel":
                return self._send(200, _load_panel_or_default())
            if path == "/api/state":
                return self._send(200, client.fetch_state(_load_panel_or_default()))
            if path == "/api/yaml-export":
                # Backwards-compat alias for /api/export/snippet.
                content = yaml_export.snippet(_load_panel_or_default())
                return self._send(200, content, "text/plain; charset=utf-8")
            if path == "/api/export/snippet":
                content = yaml_export.snippet(_load_panel_or_default())
                return self._send(200, content, "text/plain; charset=utf-8",
                                  extra_headers={"Content-Disposition": "attachment; filename=substitutions.yaml"})
            if path == "/api/export/full":
                content = yaml_export.merge_full_yaml(_load_panel_or_default())
                return self._send(200, content, "text/yaml; charset=utf-8",
                                  extra_headers={"Content-Disposition": "attachment; filename=energy_meter.yaml"})
            if path == "/api/export/zip":
                content = yaml_export.build_zip_bytes(_load_panel_or_default())
                return self._send(200, content, "application/zip",
                                  extra_headers={"Content-Disposition": "attachment; filename=energy_meter-firmware.zip"})
            if path == "/api/export/status":
                # Tells the UI whether the user has pasted their full YAML
                # (so it can show a hint nudging them toward /setup if not).
                yaml_present = bool(db.get_setting("esphome_yaml"))
                return self._send(200, {"yamlPresent": yaml_present})
            if path == "/api/full":
                p = _load_panel_or_default()
                try:
                    live = client.fetch_state(p)
                except Exception as e:
                    live = {"error": str(e)}
                return self._send(200, {
                    "schemaVersion": 1,
                    "generatedAt": datetime.utcnow().isoformat(timespec="seconds"),
                    "panel": p,
                    "live": live,
                })
            if path == "/api/channels":
                return self._send(200, panel_mod.channels_from_panel(_load_panel_or_default()))
        except client.DeviceError as e:
            return self._send(502, {"error": str(e)})
        except Exception as e:
            log.exception("GET %s failed", path)
            return self._send(500, {"error": str(e)})
        return self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._ok_auth():
            return
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/settings":
                body = self._read_json()
                # Only allow keys we know about, to avoid the UI accidentally
                # storing arbitrary data.
                for key, value in body.items():
                    if key not in db.KNOWN_SETTINGS:
                        continue
                    # Skip sentinel values from the redacted UI ("__set__" means
                    # "leave existing value alone"). Empty strings clear.
                    if value == "__set__":
                        continue
                    db.set_setting(key, str(value))
                return self._send(200, {"ok": True, "configured": db.is_configured()})

            if path == "/api/panel":
                body = self._read_json()
                db.save_panel(panel_mod.normalize_panel(body))
                return self._send(200, {"ok": True})
            if path == "/api/log":
                msg = self._read_json().get("msg", "")
                if msg:
                    _append_log(msg)
                return self._send(200, {"ok": True})
            if path == "/api/snapshot":
                p = _load_panel_or_default()
                try:
                    live = client.fetch_state(p)
                except Exception as e:
                    live = {"error": str(e)}
                name = _write_snapshot(p, live)
                _append_log(f"snapshot saved: {name}")
                return self._send(200, {"ok": True, "file": name})
            if path == "/api/cal/set-ref-v":
                b = self._read_json()
                eid = client.set_ref_v(b["chip"], b["vsuf"], b["value"])
                return self._send(200, {"ok": True, "entity": eid})
            if path == "/api/cal/set-ref-current":
                b = self._read_json()
                eid = client.set_ref_current(b["slug"], b["value"])
                return self._send(200, {"ok": True, "entity": eid})
            if path == "/api/cal/press":
                b = self._read_json()
                eid = client.press_cal_button(b["action"], b["chip"])
                return self._send(200, {"ok": True, "entity": eid})
        except client.DeviceError as e:
            return self._send(502, {"error": str(e)})
        except Exception as e:
            log.exception("POST %s failed", path)
            return self._send(500, {"error": str(e)})
        return self._send(404, {"error": "not found"})


def serve() -> None:
    logging.basicConfig(level=os.environ.get("PANEL_TOOL_LOG_LEVEL", "INFO"))
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    db.init_schema()

    if not config.SECRET_KEY:
        log.warning("SECRET_KEY is not set — secret runtime settings will be stored in plaintext. "
                    "Set SECRET_KEY in production.")

    log.info("panel-tool listening on %s:%d  (data=%s, db=%s)",
             config.HOST, config.PORT, config.DATA_DIR, _redact_db_url(config.DATABASE_URL))
    HTTPServer((config.HOST, config.PORT), Handler).serve_forever()


def _redact_db_url(url: str) -> str:
    # Strip the password from logs.
    import re
    return re.sub(r"://([^:/@]+):([^@/]+)@", r"://\1:***@", url)


if __name__ == "__main__":
    serve()
