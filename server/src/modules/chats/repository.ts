import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '../../config/database.js'
import { chats, type Chat, type NewChat } from '../../db/schema/index.js'

export class ChatsRepository {
  constructor(private readonly db: Database) {}

  async listActiveForProject(userId: string, projectId: string): Promise<Chat[]> {
    return this.db.query.chats.findMany({
      where: and(eq(chats.userId, userId), eq(chats.projectId, projectId), isNull(chats.archivedAt))
    })
  }

  async insert(values: NewChat): Promise<Chat> {
    const [row] = await this.db.insert(chats).values(values).returning()
    if (!row) {
      throw new Error('Failed to insert chat')
    }
    return row
  }
}
