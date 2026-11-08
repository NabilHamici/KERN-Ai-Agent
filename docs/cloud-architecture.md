# KERN Cloud Architecture (Phase 2E)

## Status

Phase 2E delivers the **self-hosted backend foundation and cloud data architecture**.

Implemented:

- Isolated `server/` Express + TypeScript package
- PostgreSQL schema via Drizzle ORM + versioned migrations
- Health / readiness / liveness endpoints
- SMTP email service abstraction + templates
- Ownership-aware repositories and service boundaries
- Docker Compose production and development stacks
- Future Electron cloud client contracts (offline no-ops)

Deferred to later phases:

- Phase 2F: registration, login, email verification, password reset, sessions
- Phase 2G: push/pull synchronization and conflict resolution

## Trust boundaries

```text
Electron Desktop                         Self-hosted Backend
─────────────────                        ───────────────────
Local SQLite (source of truth for        PostgreSQL (account-owned
execution, FS changes, snapshots,        conversation/mission history
operations, terminal)                    and device/project metadata)

Agent runtime / tools / PTY              Never receives source code,
stay local forever                       absolute paths, API keys,
                                         terminal dumps, or snapshots
```

Rules:

1. Local SQLite remains authoritative for local execution state.
2. The desktop app must start and operate offline without the backend.
3. The backend never mounts or browses user filesystems.
4. The backend never executes shell commands for users.
5. Cloud records store conversation history and **safe** mission/tool summaries only.

## Local Phase 2D mapping

| Local SQLite | Cloud PostgreSQL | Sync later? |
|---|---|---|
| Workspace folder | `projects` + `project_devices.local_workspace_identifier` | Yes (opaque id, never absolute path) |
| `agent_chats` | `chats` | Yes |
| `agent_missions` | `missions` | Yes |
| `agent_messages` | `messages` | Yes |
| `agent_tool_calls` | `tool_activities` (summaries only) | Yes |
| `agent_operations` / `file_changes` / snapshots | **Local only** | No |

## Package layout

```text
server/
  src/
    app.ts / server.ts
    config/          env + database
    db/schema/       Drizzle tables
    db/migrations/   SQL migrations
    modules/         health, email, repositories
    services/        ownership helpers
    contracts/       future Electron clients
  tests/
deploy/
  docker-compose.yml       production (Caddy + private Postgres)
  docker-compose.dev.yml   local validation
  caddy/Caddyfile
  scripts/backup-postgres.sh
  scripts/restore-postgres.sh
```

## API surface (Phase 2E)

Version prefix: `/api/v1`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/health` | Service + safe DB/SMTP status |
| GET | `/api/v1/ready` | Deployment readiness |
| GET | `/api/v1/live` | Process liveness |

No unauthenticated user-data endpoints exist.

## Integration path for Phase 2F / 2G

1. Phase 2F mounts auth routes under `/api/v1/auth` (rate-limited mount already reserved).
2. Authenticated requests populate `req.auth` from verified sessions — never from client-supplied user IDs.
3. Phase 2G uses `sync_changes` + version columns for idempotent sync.
4. Electron main process will call `AuthenticationClient`, `CloudProjectClient`, `CloudChatClient`, and `SyncClient` contracts without exposing secrets to the renderer.
