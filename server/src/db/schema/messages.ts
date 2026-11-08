import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { chats } from './chats.js'
import { missions } from './missions.js'

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant'])

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sequenceNumber: integer('sequence_number').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({})
  },
  (table) => [
    uniqueIndex('messages_chat_sequence_unique').on(table.chatId, table.sequenceNumber),
    index('messages_chat_created_idx').on(table.chatId, table.createdAt),
    index('messages_mission_idx').on(table.missionId),
    index('messages_user_idx').on(table.userId)
  ]
)

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
