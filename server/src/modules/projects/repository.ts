import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '../../config/database.js'
import { projectDevices, projects, type NewProject, type NewProjectDevice, type Project, type ProjectDevice } from '../../db/schema/index.js'

export class ProjectsRepository {
  constructor(private readonly db: Database) {}

  async listActiveForUser(userId: string): Promise<Project[]> {
    return this.db.query.projects.findMany({
      where: and(eq(projects.userId, userId), isNull(projects.archivedAt))
    })
  }

  async insert(values: NewProject): Promise<Project> {
    const [row] = await this.db.insert(projects).values(values).returning()
    if (!row) {
      throw new Error('Failed to insert project')
    }
    return row
  }

  async linkDevice(values: NewProjectDevice): Promise<ProjectDevice> {
    const [row] = await this.db.insert(projectDevices).values(values).returning()
    if (!row) {
      throw new Error('Failed to insert project device mapping')
    }
    return row
  }
}
