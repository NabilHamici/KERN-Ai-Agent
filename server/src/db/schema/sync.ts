import { integer, jsonb, pgEnum, pgTable, timestamp, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { userDevices } from './devices.js'

export const syncEntityTypeEnum = pgEnum('sync_entity_type', [
  'project',
  'chat',
  'mission',
  'message',
  'tool_activity',
  'device'
])

export const syncChangeTypeEnum = pgEnum('sync_change_type', ['create', 'update', 'archive', 'delete'])

/**
 * Prepared for Phase 2G synchronization. No push/pull engine in Phase 2E.
 */
export const syncChanges = pgTable(
  'sync_changes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => userDevices.id, { onDelete: 'cascade' }),
    entityType: syncEntityTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    changeType: syncChangeTypeEnum('change_type').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({})
  },
  (table) => [
    uniqueIndex('sync_changes_idempotent_unique').on(
      table.userId,
      table.deviceId,
      table.entityType,
      table.entityId,
      table.changeType,
      table.version
    ),
    index('sync_changes_user_created_idx').on(table.userId, table.createdAt),
    index('sync_changes_user_entity_idx').on(table.userId, table.entityType, table.entityId)
  ]
)

export type SyncChange = typeof syncChanges.$inferSelect
export type NewSyncChange = typeof syncChanges.$inferInsert
