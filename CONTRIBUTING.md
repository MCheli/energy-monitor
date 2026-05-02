# Contributing

Thanks for your interest. This is a small project, so this guide is short.

## Running locally

```bash
cd panel-tool
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt pytest
PANEL_TOOL_DATA_DIR=./data \
SECRET_KEY=local-dev-key-change-me-32+bytes \
  python -m app.server
```

The app boots on `http://127.0.0.1:8000`. On first run you'll be redirected to `/setup` to enter your meter URL.

## Tests

```bash
cd panel-tool
pytest -q
```

The tests use SQLite in a tmp dir. They don't talk to a real meter — `/api/state` is expected to return 502 when no device is reachable, and that's asserted.

## Trying it against your meter

You'll need a CircuitSetup 6-channel ESP32 energy meter (with or without the add-on) running ESPHome with the web server enabled. Point the `ESPHome device URL` setup field at the device's IP or `.local` hostname. No Home Assistant required for direct mode.

## Code style

- Python: standard library + the four pinned deps in `requirements.txt`. Don't add new runtime dependencies casually.
- Frontend: vanilla HTML/CSS/JS, no build step, no framework. The whole point of this tool is "open the file and read it" — keep it that way.
- Comments: prefer none. If you must explain something, explain *why*, not *what*.

## Pull requests

Run the tests, keep changes focused, and write a PR description that includes a screenshot if the UI changed. That's it.

## Reporting bugs

Use the issue templates at `.github/ISSUE_TEMPLATE/`. Include your meter setup (main vs main+addon, CT models), the YAML version (or whether you're running custom firmware), and what you saw vs. what you expected.
