import { boolean, integer, pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { projects } from './projects.js'

export const chats = pgTable(
  'chats',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    titleIsManual: boolean('title_is_manual').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    version: integer('version').notNull().default(1)
  },
  (table) => [
    index('chats_user_updated_idx').on(table.userId, table.updatedAt),
    index('chats_project_updated_idx').on(table.projectId, table.updatedAt),
    index('chats_user_project_idx').on(table.userId, table.projectId)
  ]
)

export type Chat = typeof chats.$inferSelect
export type NewChat = typeof chats.$inferInsert
