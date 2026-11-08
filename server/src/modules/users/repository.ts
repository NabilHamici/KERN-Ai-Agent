import { eq } from 'drizzle-orm'
import type { Database } from '../../config/database.js'
import { users, type NewUser, type User } from '../../db/schema/index.js'

/** Repository boundary for Phase 2F authentication services. */
export class UsersRepository {
  constructor(private readonly db: Database) {}

  async findByEmail(email: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase())
    })
  }

  async findById(id: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({
      where: eq(users.id, id)
    })
  }

  async insert(values: NewUser): Promise<User> {
    const [row] = await this.db.insert(users).values(values).returning()
    if (!row) {
      throw new Error('Failed to insert user')
    }
    return row
  }
}
