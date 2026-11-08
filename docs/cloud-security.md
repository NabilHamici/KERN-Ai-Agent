# Cloud Security Decisions (Phase 2E)

## Implemented now

- Zod-validated environment configuration with production fail-fast rules
- Helmet security headers
- Explicit CORS allowlist (no production wildcards)
- JSON / URL-encoded body size limit (`100kb`)
- Request correlation IDs
- Structured logging with credential/token redaction paths
- Rate-limit foundation on `/api/v1/auth`
- PostgreSQL not published in production Compose (`internal` network)
- Secrets excluded via `.gitignore` (`.env`, `.env.*`)
- SMTP passwords and verification tokens must never be logged
- No cloud endpoints for filesystem, terminal, or local SQLite

## Ownership model

- Client-supplied user IDs are never trusted as authentication.
- Phase 2F must derive identity from verified session/access tokens only.
- `OwnershipService` is the required gate for user-owned resources.

## Data minimization

Cloud storage may eventually include:

- Account profile metadata
- Project / chat / mission / message history
- Safe tool activity summaries
- Device registration metadata

Cloud storage must never include:

- Source code or project file contents
- Absolute workspace paths
- Terminal output dumps by default
- Local API keys / provider secrets
- File snapshots / mutation backups / reverse text blobs

## Electron boundary

- Renderer remains sandboxed and must not receive `DATABASE_URL`, SMTP credentials, or refresh tokens in plaintext beyond what Electron `safeStorage` holds in Phase 2F.
- Future cloud clients run in the main process only.

## Deferred (Phase 2F+)

- Argon2id password hashing
- Access / refresh token issuance and rotation
- Email verification and password-reset token lifecycle
- Device session revocation UX
- Full auth abuse rate limits and lockouts
