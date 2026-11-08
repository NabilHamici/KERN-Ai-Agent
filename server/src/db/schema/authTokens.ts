import { integer, pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core'
import { users } from './users.js'

export const emailVerificationOtps = pgTable(
  'email_verification_otps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index('email_verification_otps_user_idx').on(table.userId),
    index('email_verification_otps_user_active_idx').on(table.userId, table.consumedAt, table.expiresAt)
  ]
)

export const passwordResetOtps = pgTable(
  'password_reset_otps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index('password_reset_otps_user_idx').on(table.userId),
    index('password_reset_otps_user_active_idx').on(table.userId, table.consumedAt, table.expiresAt)
  ]
)

export type EmailVerificationOtp = typeof emailVerificationOtps.$inferSelect
export type PasswordResetOtp = typeof passwordResetOtps.$inferSelect
