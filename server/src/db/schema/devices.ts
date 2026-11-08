import { pgTable, text, timestamp, uuid, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { users } from './users.js'

export const userDevices = pgTable(
  'user_devices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceName: text('device_name').notNull(),
    platform: text('platform').notNull(),
    appVersion: text('app_version').notNull(),
    installationId: text('installation_id').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true })
  },
  (table) => [
    uniqueIndex('user_devices_installation_unique').on(table.installationId),
    index('user_devices_user_idx').on(table.userId),
    index('user_devices_user_last_seen_idx').on(table.userId, table.lastSeenAt)
  ]
)

export type UserDevice = typeof userDevices.$inferSelect
export type NewUserDevice = typeof userDevices.$inferInsert
