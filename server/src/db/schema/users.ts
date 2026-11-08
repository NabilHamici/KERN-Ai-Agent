import { pgEnum, pgTable, text, timestamp, uuid, uniqueIndex, index } from 'drizzle-orm/pg-core'

export const accountTypeEnum = pgEnum('account_type', ['personal'])
export const accountStatusEnum = pgEnum('account_status', ['active', 'pending_verification', 'suspended'])

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    displayName: text('display_name').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    accountType: accountTypeEnum('account_type').notNull().default('personal'),
    accountStatus: accountStatusEnum('account_status').notNull().default('pending_verification'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true })
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    index('users_status_idx').on(table.accountStatus)
  ]
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
