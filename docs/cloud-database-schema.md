# Cloud Database Schema (Phase 2E)

PostgreSQL is the cloud store. All primary keys are UUIDs. Timestamps are `timestamptz` (UTC).

## Entities

### users
Personal free accounts only (`account_type = personal`).
Statuses: `active`, `pending_verification`, `suspended`.
`password_hash` is nullable for schema flexibility; Phase 2F will require hashes for password accounts.

### user_devices
Multi-device registrations per user.
`installation_id` is unique per install and is **not** an authentication credential.

### projects
Logical account-owned projects. Not filesystem directories.

### project_devices
Maps `project_id` + `device_id` → opaque `local_workspace_identifier`.
Never store absolute local paths.

### chats
Belongs to `user_id` + `project_id`.
`title_is_manual` preserves Phase 2D manual rename behavior.
`version` supports future sync.

### missions
Multiple missions per chat. Status enum mirrors local mission lifecycle.

### messages
User/assistant content with `sequence_number` unique per chat.
`metadata` JSONB is restricted by future validators; tool payloads stay out.

### tool_activities
Safe summaries only. No terminal dumps, secrets, absolute paths, source code, or snapshots.

### sync_changes
Prepared idempotent change log for Phase 2G.
Unique on `(user_id, device_id, entity_type, entity_id, change_type, version)`.

### sessions
Prepared for Phase 2F. Stores **refresh token hashes only**.

## Ownership

Every user-owned row includes `user_id` (directly or via enforced joins).
Foreign keys use cascade/restrict intentionally:

- Deleting a user cascades devices/projects/chats/missions/messages/sessions/sync rows.
- Deleting a project cascades chats and dependent conversation data.
- Deleting a chat cascades missions/messages/tool activities.

Service-layer ownership checks live in `OwnershipService` and must be used by all authenticated handlers in Phase 2F+.

## Migrations

```bash
cd server
pnpm db:generate   # after schema edits
pnpm db:migrate    # apply to DATABASE_URL
```

Migration files: `server/src/db/migrations/`.

## Compatibility with Phase 2D local IDs

Future sync should preserve local UUIDs when uploading chats/missions/messages so desktop and cloud refer to the same entity IDs where practical.
Local-only tables (`file_changes`, `agent_operations`, snapshots) are never migrated to PostgreSQL.
