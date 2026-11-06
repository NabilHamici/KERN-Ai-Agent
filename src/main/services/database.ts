import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { FileChangeRecord, MissionRecord } from '../../shared/ipc.ts'

const MIGRATIONS = [
  `CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  `CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  `CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE mission_events (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  `CREATE TABLE file_changes (
      id TEXT PRIMARY KEY,
      mission_id TEXT,
      relative_path TEXT NOT NULL,
      change_type TEXT NOT NULL,
      reverse_text TEXT,
      created_at TEXT NOT NULL
    )`
]

export class MissionDatabase {
  private readonly db: DatabaseSync

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    const current = this.currentVersion()
    for (let index = current; index < MIGRATIONS.length; index += 1) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(MIGRATIONS[index]!)
        this.db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(index + 1, new Date().toISOString())
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  private currentVersion(): number {
    const table = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() as { name: string } | undefined
    if (!table) {
      return 0
    }
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      | { version: number | null }
      | undefined
    return row?.version ?? 0
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  createMission(workspacePath: string, title: string): MissionRecord {
    const now = new Date().toISOString()
    const mission: MissionRecord = {
      id: crypto.randomUUID(),
      workspacePath,
      title,
      status: 'open',
      createdAt: now,
      updatedAt: now
    }
    this.db
      .prepare(
        `INSERT INTO missions (id, workspace_path, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(mission.id, mission.workspacePath, mission.title, mission.status, mission.createdAt, mission.updatedAt)
    this.addEvent(mission.id, 'session', 'Workspace session opened')
    return mission
  }

  addEvent(missionId: string, kind: string, message: string): void {
    this.db
      .prepare(
        `INSERT INTO mission_events (id, mission_id, kind, message, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), missionId, kind, message, new Date().toISOString())
    this.db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), missionId)
  }

  recordFileChange(input: {
    missionId: string | null
    relativePath: string
    changeType: string
    reverseText: string | null
  }): void {
    this.db
      .prepare(
        `INSERT INTO file_changes (id, mission_id, relative_path, change_type, reverse_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        input.missionId,
        input.relativePath,
        input.changeType,
        input.reverseText,
        new Date().toISOString()
      )
    if (input.missionId) {
      this.addEvent(input.missionId, 'file', `${input.changeType} ${input.relativePath}`)
    }
  }

  listMissions(limit = 50): MissionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_path, title, status, created_at, updated_at
         FROM missions ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      id: string
      workspace_path: string
      title: string
      status: string
      created_at: string
      updated_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      workspacePath: row.workspace_path,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  listFileChanges(limit = 50): FileChangeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, mission_id, relative_path, change_type, reverse_text, created_at
         FROM file_changes ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      id: string
      mission_id: string | null
      relative_path: string
      change_type: string
      reverse_text: string | null
      created_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      missionId: row.mission_id,
      relativePath: row.relative_path,
      changeType: row.change_type,
      createdAt: row.created_at,
      hasReverse: row.reverse_text !== null
    }))
  }
}
