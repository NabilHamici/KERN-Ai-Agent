import { and, eq } from 'drizzle-orm'
import type { Database } from '../../config/database.js'
import { missions, type Mission, type NewMission } from '../../db/schema/index.js'

export class MissionsRepository {
  constructor(private readonly db: Database) {}

  async listForChat(userId: string, chatId: string): Promise<Mission[]> {
    return this.db.query.missions.findMany({
      where: and(eq(missions.userId, userId), eq(missions.chatId, chatId))
    })
  }

  async insert(values: NewMission): Promise<Mission> {
    const [row] = await this.db.insert(missions).values(values).returning()
    if (!row) {
      throw new Error('Failed to insert mission')
    }
    return row
  }
}
