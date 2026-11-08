import { and, eq } from 'drizzle-orm'
import type { Database } from '../../config/database.js'
import { messages, type Message, type NewMessage } from '../../db/schema/index.js'

export class MessagesRepository {
  constructor(private readonly db: Database) {}

  async listForChat(userId: string, chatId: string): Promise<Message[]> {
    return this.db.query.messages.findMany({
      where: and(eq(messages.userId, userId), eq(messages.chatId, chatId))
    })
  }

  async insert(values: NewMessage): Promise<Message> {
    const [row] = await this.db.insert(messages).values(values).returning()
    if (!row) {
      throw new Error('Failed to insert message')
    }
    return row
  }
}
