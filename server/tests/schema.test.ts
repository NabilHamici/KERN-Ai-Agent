import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createPool } from '../src/config/database.ts'
import * as schema from '../src/db/schema/index.ts'

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations')

maybeDescribe('database schema and ownership', () => {
  const pool = createPool(databaseUrl!)
  const db = drizzle(pool, { schema })

  beforeAll(async () => {
    await migrate(db, { migrationsFolder })
  })

  afterAll(async () => {
    await pool.end()
  })

  it('creates required tables', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [
        [
          'users',
          'user_devices',
          'projects',
          'project_devices',
          'chats',
          'missions',
          'messages',
          'tool_activities',
          'sync_changes',
          'sessions',
          'email_verification_otps',
          'password_reset_otps'
        ]
      ]
    )
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'chats',
      'email_verification_otps',
      'messages',
      'missions',
      'password_reset_otps',
      'project_devices',
      'projects',
      'sessions',
      'sync_changes',
      'tool_activities',
      'user_devices',
      'users'
    ])
  })

  it('enforces unique email and installation id constraints', async () => {
    const email = `phase2e-${Date.now()}@example.com`
    const installationId = `install-${Date.now()}`
    const user = await db
      .insert(schema.users)
      .values({
        email,
        displayName: 'Phase 2E',
        accountType: 'personal',
        accountStatus: 'pending_verification'
      })
      .returning()
    const userId = user[0]!.id

    await expect(
      db.insert(schema.users).values({
        email,
        displayName: 'Duplicate',
        accountType: 'personal',
        accountStatus: 'pending_verification'
      })
    ).rejects.toThrow()

    await db.insert(schema.userDevices).values({
      userId,
      deviceName: 'Device A',
      platform: 'darwin',
      appVersion: '0.1.0',
      installationId
    })

    await expect(
      db.insert(schema.userDevices).values({
        userId,
        deviceName: 'Device B',
        platform: 'darwin',
        appVersion: '0.1.0',
        installationId
      })
    ).rejects.toThrow()
  })

  it('cascades project deletion and keeps ownership foreign keys', async () => {
    const stamp = Date.now()
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `owner-${stamp}@example.com`,
        displayName: 'Owner',
        accountType: 'personal',
        accountStatus: 'active',
        emailVerifiedAt: new Date()
      })
      .returning()
    const [project] = await db
      .insert(schema.projects)
      .values({
        userId: user!.id,
        name: 'Demo',
        description: 'Cloud project'
      })
      .returning()
    const [chat] = await db
      .insert(schema.chats)
      .values({
        userId: user!.id,
        projectId: project!.id,
        title: 'Fix authentication',
        titleIsManual: false,
        version: 1
      })
      .returning()
    const [mission] = await db
      .insert(schema.missions)
      .values({
        chatId: chat!.id,
        userId: user!.id,
        status: 'completed',
        version: 1
      })
      .returning()
    await db.insert(schema.messages).values({
      chatId: chat!.id,
      missionId: mission!.id,
      userId: user!.id,
      role: 'user',
      content: 'Analyze auth',
      sequenceNumber: 1,
      metadata: {}
    })

    await db.delete(schema.projects).where(eq(schema.projects.id, project!.id))
    const leftoverChats = await pool.query('SELECT id FROM chats WHERE id = $1', [chat!.id])
    const leftoverMissions = await pool.query('SELECT id FROM missions WHERE id = $1', [mission!.id])
    expect(leftoverChats.rowCount).toBe(0)
    expect(leftoverMissions.rowCount).toBe(0)
  })

  it('keeps local workspace mapping opaque in migrations', () => {
    const migration = readdirSync(migrationsFolder).find((name) => name.endsWith('.sql'))
    expect(migration).toBeTruthy()
    const sql = readFileSync(path.join(migrationsFolder, migration!), 'utf8')
    expect(sql).toContain('local_workspace_identifier')
    expect(sql).not.toMatch(/workspace_path/)
  })
})
