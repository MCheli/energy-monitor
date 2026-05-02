#!/usr/bin/env bash
set -euo pipefail

# Ensure the data dir exists (idempotent) and migrations are applied.
mkdir -p "${PANEL_TOOL_DATA_DIR:-/data}"

# Alembic upgrade is idempotent — safe to run on every boot.
alembic -c /app/alembic.ini upgrade head

exec "$@"
