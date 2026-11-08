# Self-hosted Deployment (Phase 2E)

Target: a single Ubuntu VPS with Docker, Docker Compose, PostgreSQL, the KERN backend, and Caddy for HTTPS.

This document does **not** deploy to a real server or change DNS. No IP/domain is hardcoded.

## Prerequisites

- Ubuntu 22.04+ (or equivalent)
- Docker Engine + Compose plugin
- A DNS A/AAAA record pointing your domain at the VPS
- SMTP credentials from any provider

## Files

```text
deploy/docker-compose.yml
deploy/caddy/Caddyfile
deploy/scripts/backup-postgres.sh
deploy/scripts/restore-postgres.sh
server/Dockerfile
server/.env.example
```

## Environment

Create `deploy/.env` on the server (never commit it):

```env
POSTGRES_DB=kern
POSTGRES_USER=kern
POSTGRES_PASSWORD=replace-me
APP_URL=https://your-domain.example
CORS_ORIGINS=https://your-desktop-origin.example
KERN_DOMAIN=your-domain.example
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM_NAME=KERN
SMTP_FROM_EMAIL=noreply@your-domain.example
LOG_LEVEL=info
```

## Deploy steps

```bash
cd deploy
docker compose pull
docker compose build
docker compose --profile migrate run --rm migrate
docker compose up -d
docker compose ps
curl -fsS https://your-domain.example/api/v1/health
```

## Networking

- PostgreSQL joins an **internal** Docker network and has **no public ports**.
- Backend talks to Postgres privately.
- Only Caddy publishes `80/443`.

## Backups

Daily logical backups:

```bash
cd deploy
./scripts/backup-postgres.sh ./backups
```

Retention recommendation:

- Keep daily backups for 7 days
- Keep weekly backups for 4 weeks
- Store copies off-box when possible

Restore (destructive):

```bash
./scripts/restore-postgres.sh ./backups/kern-postgres-YYYYMMDDTHHMMSSZ.sql.gz
```

## Local validation stack

```bash
cd deploy
docker compose -f docker-compose.dev.yml up -d --build
docker compose -f docker-compose.dev.yml --profile migrate run --rm migrate
curl -fsS http://127.0.0.1:4000/api/v1/health
```

Dev Compose publishes the API on `localhost:4000` and Postgres on `localhost:54329` for developer convenience. Production Compose does not publish Postgres.
