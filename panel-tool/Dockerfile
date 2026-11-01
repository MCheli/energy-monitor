# Pin the Debian release explicitly so a base-image retag can't silently move
# us to a different distro.
FROM python:3.11-slim-trixie AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# psycopg2 needs libpq at runtime; build deps not needed because we use the binary wheel.
# No curl: it was only used by the healthcheck and dragged in libcurl +
# libbrotli1 (CVE-2026-111497). The healthcheck below uses Python instead.
# `upgrade` picks up Debian security fixes newer than the base image tag.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends tini libpq5 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# requirements.txt is the pinned lockfile (compiled from requirements.in), so a rebuild never
# pulls new library versions (an unpinned rebuild once pulled SQLAlchemy 2.1 and crash-looped).
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
COPY alembic ./alembic
COPY alembic.ini .
COPY static ./static
COPY entrypoint.sh .
RUN chmod +x /app/entrypoint.sh

# Non-root runtime user. /data is the bind-mount target; create it so the app
# can write the SQLite file even if the volume is fresh.
RUN useradd -u 1000 -m -d /home/app app \
 && mkdir -p /data \
 && chown -R app:app /data /app

USER app
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).read()"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["python", "-m", "app.server"]
