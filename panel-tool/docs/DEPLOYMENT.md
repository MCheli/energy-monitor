# Deploying panel-tool to a homelab

This guide is written for an operator (or an agent acting on their behalf) who already runs services on a single home server with these ingredients:

- Docker + `docker compose` orchestrating multiple services on one box.
- An `nginx` container fronting everything, with TLS terminating there.
- A wildcard / per-host DNS pattern for "internal" apps that should only be reachable from the LAN — e.g. `{app}.ops.example.com`.
- A `.env` file pattern for app secrets, sourced into compose.
- A nightly backup script that runs `pg_dump` for each service that has a database.

If your environment matches that shape, this guide tells you exactly what to wire up. If it doesn't, the **Generic requirements** section near the top describes what the app *needs* and you can adapt from there.

---

## What you are deploying

`panel-tool` is a small single-process web app:

- **Language:** Python 3.11+, standard library only at runtime (no pip install needed if you're running locally; the Docker image already has what it needs).
- **Frontend:** static HTML/CSS/JS served by the Python server; no build step.
- **State:** PostgreSQL (or SQLite, in the bundled default compose). Schema is managed by the app at startup.
- **Inbound traffic:** a single HTTP port (default `8000`).
- **Outbound traffic:** the app talks to one ESPHome device (configurable via the in-app setup page) and optionally to a Home Assistant instance. Both URLs are entered through the UI, not env vars — you do **not** need to know them at deploy time.

The user-facing surface is a control panel for mapping circuit breakers to CT (current transformer) channels on an ESPHome energy meter. Treat it like any other internal-only LAN tool.

---

## Generic requirements

If you're not following the exact homelab pattern below, here is the abstract set of things any deployment must provide:

| Need | What the app expects |
|------|----------------------|
| Runtime | Python 3.11+ or the published Docker image |
| Inbound port | Configurable via `PANEL_TOOL_PORT` (default `8000`); HTTP only, terminate TLS upstream |
| Database | A Postgres 14+ database the app can connect to via `DATABASE_URL`. SQLite (`sqlite:///data/panel.db`) is also supported and is the default if `DATABASE_URL` is unset. |
| Persistent disk | One writable directory for snapshots and logs (`PANEL_TOOL_DATA_DIR`, default `/data`). Roughly 100 MB is plenty. |
| Secrets at deploy time | Only `SECRET_KEY` (random 32+ byte string used to encrypt the HA token at rest) and the database password. Everything else (ESPHome URL, HA URL, HA token) is configured via the in-app setup screen on first launch. |
| Network egress | The app must be able to reach whatever ESPHome / HA hosts the user enters. In the homelab pattern that's the same LAN. |
| Auth | The app ships **without** built-in auth. It assumes a trusted network. You are responsible for putting it behind nginx ACLs / VPN / SSO / etc. |

That's the whole contract. The rest of this guide is one specific way to satisfy it.

---

## Homelab pattern: step-by-step

### Inputs you should get from the operator

Before starting, confirm these values with the operator. Don't guess — different operators will have different conventions.

- **Hostname** the app should be reachable at, e.g. `panel.ops.example.com`. Default suggestion: `panel.ops.<their-domain>`.
- **LAN CIDR** that should be allowed (e.g. `192.168.1.0/24`). Default suggestion: deny-all + allow the operator's LAN range.
- **TLS certificate** that covers the chosen subdomain. In the `.ops` pattern this is usually a Let's Encrypt cert dedicated to the internal subdomain, distinct from the public-facing wildcard.
- **Container network** name(s) the app should join so nginx can reach it.
- **Backup script path** (if any) that should be extended to dump the new database.

If any of these are unknown, **stop and ask** rather than picking a value.

### Step 1 — DNS

Add an A record for the chosen subdomain pointing at the home server's **LAN IP** (not its public IP). If using Cloudflare or similar, set the record to **DNS-only / unproxied** — this app is LAN-only and there is no value in exposing it through the CDN.

### Step 2 — Secrets

Append to the operator's existing `.env` (or whatever file `env_file:` in compose points at):

```
# panel-tool
PANEL_TOOL_DB_PASSWORD=<generate a strong random password>
PANEL_TOOL_SECRET_KEY=<generate 32+ random bytes, base64 or hex>
```

Both values are sensitive. Generate them on the server (`openssl rand -base64 32`) and never commit them. Confirm the `.env` file has owner-only read permissions.

### Step 3 — Compose service

Add two services to the operator's `docker-compose.yml`. Keep style consistent with what's already there (image tags, restart policies, networks, healthchecks, label conventions). The shape:

```yaml
services:
  panel-tool-db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: panel_tool
      POSTGRES_PASSWORD: ${PANEL_TOOL_DB_PASSWORD}
      POSTGRES_DB: panel_tool
    volumes:
      - panel_tool_db_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U panel_tool"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - <internal-net-name>

  panel-tool:
    image: ghcr.io/<owner>/panel-tool:latest
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_URL: postgresql://panel_tool:${PANEL_TOOL_DB_PASSWORD}@panel-tool-db:5432/panel_tool
      SECRET_KEY: ${PANEL_TOOL_SECRET_KEY}
      PANEL_TOOL_DATA_DIR: /data
    volumes:
      - panel_tool_data:/data
    depends_on:
      panel-tool-db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health').read()"]
      interval: 30s
      timeout: 5s
      retries: 3
    networks:
      - <internal-net-name>
      - <nginx-facing-net-name>

volumes:
  panel_tool_db_data:
  panel_tool_data:
```

Replace `<owner>` with the GitHub org/user the image is published under, and the network names with whatever the operator already uses. **Do not** publish ports on the host (`ports:`) — nginx reaches the app over the docker network.

### Step 4 — nginx server block

Add a server block alongside the operator's other `*.ops` apps. Match the style of the neighboring blocks; here is the canonical shape:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name panel.ops.example.com;

    ssl_certificate     /etc/nginx/certs/<ops-cert>.crt;
    ssl_certificate_key /etc/nginx/certs/<ops-cert>.key;

    add_header Strict-Transport-Security "max-age=31536000" always;

    # LAN-only — replace with the operator's actual CIDR
    allow 192.168.1.0/24;
    allow 127.0.0.1;
    deny all;

    location / {
        proxy_pass         http://panel-tool:8000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

Also add the new hostname to the existing port-80 → port-443 redirect block (most homelabs have a single catch-all redirect server with a long `server_name` list).

If the operator uses basic auth on `.ops` services *in addition to* the IP allowlist, mirror that. Don't decide unilaterally — ask.

### Step 5 — Bring it up

```
docker compose pull panel-tool
docker compose up -d panel-tool-db panel-tool
docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload
```

The app creates its schema on first start; there is no separate migration step to run.

### Step 6 — Validate

From a machine on the LAN:

1. `curl -sSf https://panel.ops.example.com/api/health` returns `200`.
2. Browser-open the same URL. Because no setup has happened yet, the app should redirect (or render) a setup page asking for the ESPHome device URL. Hand the URL to the operator and let them complete it — **do not** enter their LAN device URL or HA token on their behalf.
3. From a non-LAN network (or `curl --interface` with a non-allowed source), confirm the same URL returns `403`. If it doesn't, the IP allowlist isn't doing what you think it is — fix it before declaring done.

### Step 7 — Backups

If the operator has a backup script that pg_dumps other services, extend it to include `panel-tool-db`. The pattern is usually a one-line addition next to the existing dumps. Confirm the next scheduled run produces an artifact for the new database.

### Step 8 — Hand-off notes

Tell the operator:

- The URL.
- That first-run setup happens through the UI; they will be asked for the ESPHome device URL and (optionally) a Home Assistant URL + long-lived access token.
- Where logs are (`docker compose logs panel-tool`) and where state is (the `panel_tool_data` volume + the `panel-tool-db` volume).
- That the HA token, if entered, is encrypted at rest using `SECRET_KEY` — rotating `SECRET_KEY` will invalidate the stored token and require re-entry.
- That changing the ESPHome URL later is done in-app, not by editing config.

---

## Things to push back on

If the operator asks for any of the following, push back before doing them:

- **Public exposure** (e.g. proxied through Cloudflare, no IP allowlist). The app has no auth. Don't deploy it open-internet.
- **Sharing a database with another app.** Use a dedicated `panel-tool-db` even if a shared Postgres exists. Cheap, isolates blast radius, simplifies backups.
- **Storing the HA token in `.env` instead of via the UI.** The setup-page flow is deliberate so non-technical users can rotate it without redeploying. Env-var-only mode is supported as an escape hatch but isn't the default.
- **Skipping the healthcheck.** It's how the operator's monitoring will tell them the app died.

---

## Rollback

The deployment is two containers, two volumes, and one nginx file. To roll back:

1. `docker compose stop panel-tool panel-tool-db`
2. Revert the nginx server block, reload nginx.
3. (Optional, destructive) `docker compose rm -f panel-tool panel-tool-db && docker volume rm <prefix>_panel_tool_data <prefix>_panel_tool_db_data`.

The DNS record can stay; it will simply 502 / not resolve internally with no harm done.

---

## Quickstart for non-homelab users

If the deployer is *not* on a multi-service homelab and just wants the app on a Raspberry Pi or laptop, point them at the repo's top-level `README.md` and `docker-compose.yml`. Default compose runs the app against SQLite on `localhost:8000`, no nginx, no Postgres, no secrets file. They should not be reading this document.
