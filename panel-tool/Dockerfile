FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# psycopg2 needs libpq at runtime; build deps not needed because we use the binary wheel.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tini libpq5 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

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
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["python", "-m", "app.server"]
