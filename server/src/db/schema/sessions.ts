import { pgTable, text, timestamp, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { userDevices } from './devices.js'

/**
 * Phase 2F authentication sessions. Stores refresh token hashes only.
 * familyId groups rotated refresh tokens for reuse detection.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => userDevices.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBySessionId: uuid('replaced_by_session_id')
  },
  (table) => [
    uniqueIndex('sessions_refresh_token_hash_unique').on(table.refreshTokenHash),
    index('sessions_user_idx').on(table.userId),
    index('sessions_device_idx').on(table.deviceId),
    index('sessions_expires_idx').on(table.expiresAt),
    index('sessions_family_idx').on(table.familyId)
  ]
)

export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
