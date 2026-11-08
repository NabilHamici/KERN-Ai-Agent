import { pgTable, text, timestamp, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { userDevices } from './devices.js'

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true })
  },
  (table) => [
    index('projects_user_updated_idx').on(table.userId, table.updatedAt),
    index('projects_user_archived_idx').on(table.userId, table.archivedAt)
  ]
)

/**
 * Maps a logical cloud project to a local workspace on one device.
 * localWorkspaceIdentifier must be a non-path opaque identifier (e.g. hashed canonical root),
 * never an absolute filesystem path.
 */
export const projectDevices = pgTable(
  'project_devices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => userDevices.id, { onDelete: 'cascade' }),
    localWorkspaceIdentifier: text('local_workspace_identifier').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex('project_devices_project_device_unique').on(table.projectId, table.deviceId),
    uniqueIndex('project_devices_device_workspace_unique').on(table.deviceId, table.localWorkspaceIdentifier),
    index('project_devices_project_idx').on(table.projectId),
    index('project_devices_device_idx').on(table.deviceId)
  ]
)

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
export type ProjectDevice = typeof projectDevices.$inferSelect
export type NewProjectDevice = typeof projectDevices.$inferInsert
