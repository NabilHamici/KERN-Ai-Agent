import { and, eq } from 'drizzle-orm'
import type { Database } from '../config/database.js'
import { chats, missions, messages, projects, toolActivities, userDevices } from '../db/schema/index.js'
import { ForbiddenError, NotFoundError } from '../utils/errors.js'

/**
 * Ownership helpers for Phase 2F+. Never trust a client-supplied userId as proof of ownership.
 * Authenticated identity must come from verified server-side session/token context.
 */
export class OwnershipService {
  constructor(private readonly db: Database) {}

  async requireOwnedProject(userId: string, projectId: string) {
    const row = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.userId, userId))
    })
    if (!row) {
      throw new NotFoundError('Project not found')
    }
    return row
  }

  async requireOwnedChat(userId: string, chatId: string) {
    const row = await this.db.query.chats.findFirst({
      where: and(eq(chats.id, chatId), eq(chats.userId, userId))
    })
    if (!row) {
      throw new NotFoundError('Chat not found')
    }
    return row
  }

  async requireOwnedMission(userId: string, missionId: string) {
    const row = await this.db.query.missions.findFirst({
      where: and(eq(missions.id, missionId), eq(missions.userId, userId))
    })
    if (!row) {
      throw new NotFoundError('Mission not found')
    }
    return row
  }

  async requireOwnedMessage(userId: string, messageId: string) {
    const row = await this.db.query.messages.findFirst({
      where: and(eq(messages.id, messageId), eq(messages.userId, userId))
    })
    if (!row) {
      throw new NotFoundError('Message not found')
    }
    return row
  }

  async requireOwnedToolActivity(userId: string, activityId: string) {
    const row = await this.db.query.toolActivities.findFirst({
      where: and(eq(toolActivities.id, activityId), eq(toolActivities.userId, userId))
    })
    if (!row) {
      throw new NotFoundError('Tool activity not found')
    }
    return row
  }

  async requireOwnedDevice(userId: string, deviceId: string) {
    const row = await this.db.query.userDevices.findFirst({
      where: and(eq(userDevices.id, deviceId), eq(userDevices.userId, userId))
    })
    if (!row || row.revokedAt) {
      throw new NotFoundError('Device not found')
    }
    return row
  }

  assertSameUser(authenticatedUserId: string, resourceUserId: string): void {
    if (authenticatedUserId !== resourceUserId) {
      throw new ForbiddenError('Cross-account access is not allowed')
    }
  }
}
