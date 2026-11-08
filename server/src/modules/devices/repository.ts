import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '../../config/database.js'
import { userDevices, type NewUserDevice, type UserDevice } from '../../db/schema/index.js'

export class DevicesRepository {
  constructor(private readonly db: Database) {}

  async findActiveByInstallationId(installationId: string): Promise<UserDevice | undefined> {
    return this.db.query.userDevices.findFirst({
      where: and(eq(userDevices.installationId, installationId), isNull(userDevices.revokedAt))
    })
  }

  async listForUser(userId: string): Promise<UserDevice[]> {
    return this.db.query.userDevices.findMany({
      where: and(eq(userDevices.userId, userId), isNull(userDevices.revokedAt))
    })
  }

  async insert(values: NewUserDevice): Promise<UserDevice> {
    const [row] = await this.db.insert(userDevices).values(values).returning()
    if (!row) {
      throw new Error('Failed to insert device')
    }
    return row
  }
}
