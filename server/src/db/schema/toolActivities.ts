import { jsonb, pgEnum, pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { chats } from './chats.js'
import { missions } from './missions.js'
import { messages } from './messages.js'

export const toolActivityTypeEnum = pgEnum('tool_activity_type', [
  'started',
  'finished',
  'rejected',
  'failed',
  'awaiting_approval'
])

export const toolActivityStatusEnum = pgEnum('tool_activity_status', [
  'running',
  'completed',
  'rejected',
  'failed',
  'awaiting_approval'
])

/**
 * Safe tool activity summaries only. Never store terminal dumps, secrets,
 * absolute paths, source code, or file snapshots here.
 */
export const toolActivities = pgTable(
  'tool_activities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    activityType: toolActivityTypeEnum('activity_type').notNull(),
    status: toolActivityStatusEnum('status').notNull(),
    summary: text('summary').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({})
  },
  (table) => [
    index('tool_activities_mission_created_idx').on(table.missionId, table.createdAt),
    index('tool_activities_chat_created_idx').on(table.chatId, table.createdAt),
    index('tool_activities_user_idx').on(table.userId)
  ]
)

export type ToolActivity = typeof toolActivities.$inferSelect
export type NewToolActivity = typeof toolActivities.$inferInsert
