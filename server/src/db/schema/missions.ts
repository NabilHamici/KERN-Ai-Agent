import { integer, pgEnum, pgTable, timestamp, uuid, index } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { chats } from './chats.js'

export const missionStatusEnum = pgEnum('mission_status', [
  'queued',
  'analyzing',
  'planning',
  'awaiting_approval',
  'executing',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
])

export const missions = pgTable(
  'missions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: missionStatusEnum('status').notNull().default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1)
  },
  (table) => [
    index('missions_chat_created_idx').on(table.chatId, table.createdAt),
    index('missions_user_updated_idx').on(table.userId, table.updatedAt),
    index('missions_user_status_idx').on(table.userId, table.status)
  ]
)

export type Mission = typeof missions.$inferSelect
export type NewMission = typeof missions.$inferInsert
