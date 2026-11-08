# Phase 2F Authentication Plan

Phase 2E prepared schema and service boundaries only. Authentication is **not** production-ready yet.

## Intended design

1. **Password hashing:** Argon2id
2. **Email verification:** time-limited single-use tokens emailed via SMTP templates already prepared
3. **Access tokens:** short-lived JWTs or opaque tokens
4. **Refresh tokens:** rotating; desktop stores ciphertext in Electron `safeStorage`; server stores hashes in `sessions.refresh_token_hash`
5. **Device sessions:** created at login, revocable via `sessions.revoked_at` / `user_devices.revoked_at`
6. **Password reset:** time-limited single-use tokens; generic success responses
7. **Rate limiting:** registration, login, verification, and reset endpoints (auth mount already rate-limited)
8. **Anti-enumeration:** generic auth error messages

## Endpoints (planned)

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/refresh
POST /api/v1/auth/verify-email
POST /api/v1/auth/password/forgot
POST /api/v1/auth/password/reset
GET  /api/v1/auth/me
```

## Electron integration

- Main-process `AuthenticationClient` only
- Renderer never sees SMTP or database credentials
- Offline desktop continues to work when logged out or offline

## Non-goals for 2F

- Team/org accounts
- Billing / subscriptions
- Cloud agent execution
- Sync push/pull (Phase 2G)
