# `@kern/server` — Phase 2E Backend Foundation

Self-hosted Express + PostgreSQL + Drizzle backend for future KERN accounts and sync.

The Electron desktop app does **not** depend on this package at runtime in Phase 2E.

## Quick start

```bash
cd server
cp .env.example .env
# edit DATABASE_URL / SMTP / APP_URL / CORS_ORIGINS
pnpm install
pnpm db:migrate
pnpm dev
```

Health:

```bash
curl -fsS http://127.0.0.1:4000/api/v1/health
curl -fsS http://127.0.0.1:4000/api/v1/ready
curl -fsS http://127.0.0.1:4000/api/v1/live
```

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | Start API with reload |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run compiled server |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest suite |
| `pnpm db:generate` | Generate Drizzle migrations |
| `pnpm db:migrate` | Apply migrations |
| `pnpm smtp:verify` | Verify SMTP connectivity |

## What is implemented

- Schema for users, devices, projects, chats, missions, messages, tool activities, sync_changes, sessions
- Health / readiness / liveness
- SMTP service + verification/reset/device email templates
- Security middleware, validation, ownership helpers
- Offline Electron client contracts under `src/contracts/`

## What is not implemented

- Login/registration UI or flows
- Token issuance / refresh rotation
- Cloud sync push/pull
- Any filesystem or terminal proxy APIs

See `/docs` for architecture, schema, security, deployment, and Phase 2F plans.
