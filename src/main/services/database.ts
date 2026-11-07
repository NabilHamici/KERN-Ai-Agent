import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  canTransition,
  isMissionStatus,
  missionTitle,
  type AgentMissionSummary,
  type AgentTranscript,
  type MissionStatus
} from '../../shared/agent.ts'
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
    )`,
  `CREATE TABLE agent_missions (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      tool_calls INTEGER NOT NULL,
      summary TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  `CREATE TABLE agent_tool_calls (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      name TEXT NOT NULL,
      arguments TEXT NOT NULL,
      status TEXT NOT NULL,
      output TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  `CREATE TABLE agent_events (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
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

  createAgentMission(workspacePath: string, prompt: string): AgentMissionSummary {
    const now = new Date().toISOString()
    const mission: AgentMissionSummary = {
      id: crypto.randomUUID(),
      title: missionTitle(prompt),
      prompt,
      status: 'queued',
      iteration: 0,
      toolCalls: 0,
      summary: null,
      error: null,
      createdAt: now,
      updatedAt: now
    }
    this.db
      .prepare(
        `INSERT INTO agent_missions (
           id, workspace_path, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?)`
      )
      .run(mission.id, workspacePath, mission.title, mission.prompt, mission.status, mission.createdAt, mission.updatedAt)
    this.addAgentEvent(mission.id, 'status', 'queued')
    return mission
  }

  getAgentMission(id: string): AgentMissionSummary | null {
    const row = this.db
      .prepare(
        `SELECT id, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at
         FROM agent_missions WHERE id = ?`
      )
      .get(id) as AgentMissionRow | undefined
    return row ? mapAgentMission(row) : null
  }

  activeAgentMission(): AgentMissionSummary | null {
    const row = this.db
      .prepare(
        `SELECT id, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at
         FROM agent_missions
         WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get() as AgentMissionRow | undefined
    return row ? mapAgentMission(row) : null
  }

  listAgentMissions(limit = 20): AgentMissionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at
         FROM agent_missions ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as AgentMissionRow[]
    return rows.map(mapAgentMission)
  }

  transitionAgentMission(id: string, status: MissionStatus, patch: { summary: string | null; error: string | null }): boolean {
    const current = this.getAgentMission(id)
    if (!current || !canTransition(current.status, status)) {
      return false
    }
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE agent_missions
         SET status = ?, summary = COALESCE(?, summary), error = COALESCE(?, error), updated_at = ?
         WHERE id = ?`
      )
      .run(status, patch.summary, patch.error, now, id)
    this.addAgentEvent(id, 'status', status)
    return true
  }

  setAgentOutcome(id: string, summary: string | null, error: string | null): void {
    this.db
      .prepare(
        `UPDATE agent_missions
         SET summary = COALESCE(?, summary), error = COALESCE(?, error), updated_at = ?
         WHERE id = ?`
      )
      .run(summary, error, new Date().toISOString(), id)
  }

  setAgentCounters(id: string, iteration: number, toolCalls: number): void {
    this.db
      .prepare('UPDATE agent_missions SET iteration = ?, tool_calls = ?, updated_at = ? WHERE id = ?')
      .run(iteration, toolCalls, new Date().toISOString(), id)
  }

  appendAgentMessage(missionId: string, role: string, content: string): void {
    const text = content.slice(0, 32_000)
    if (!text) {
      return
    }
    this.db
      .prepare('INSERT INTO agent_messages (id, mission_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), missionId, role, text, new Date().toISOString())
  }

  recordAgentTool(input: {
    missionId: string
    callId: string
    name: string
    argumentsText: string
    state: 'finished' | 'rejected'
    output: string
  }): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO agent_tool_calls (id, mission_id, call_id, name, arguments, status, output, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), input.missionId, input.callId, input.name, input.argumentsText, input.state, input.output, now)
    this.db.prepare('UPDATE agent_missions SET tool_calls = tool_calls + 1, updated_at = ? WHERE id = ?').run(now, input.missionId)
    this.addAgentEvent(input.missionId, 'tool', `${input.state} ${input.name}`)
  }

  agentTranscript(id: string): AgentTranscript | null {
    const mission = this.getAgentMission(id)
    if (!mission) {
      return null
    }
    const messages = this.db
      .prepare('SELECT role, content, created_at FROM agent_messages WHERE mission_id = ? ORDER BY created_at ASC')
      .all(id) as Array<{ role: string; content: string; created_at: string }>
    const tools = this.db
      .prepare(
        `SELECT call_id, name, arguments, status, output, created_at
         FROM agent_tool_calls WHERE mission_id = ? ORDER BY created_at ASC`
      )
      .all(id) as Array<{ call_id: string; name: string; arguments: string; status: string; output: string; created_at: string }>
    return {
      mission,
      messages: messages.map((row) => ({ role: row.role, content: row.content, createdAt: row.created_at })),
      tools: tools.map((row) => ({
        callId: row.call_id,
        name: row.name,
        argumentsText: row.arguments,
        state: row.status === 'rejected' ? 'rejected' : 'finished',
        output: row.output,
        createdAt: row.created_at
      }))
    }
  }

  interruptAgentMissions(): number {
    const now = new Date().toISOString()
    const result = this.db
      .prepare(
        `UPDATE agent_missions
         SET status = 'interrupted',
             error = COALESCE(error, 'The mission was interrupted because KERN exited.'),
             updated_at = ?
         WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')`
      )
      .run(now)
    return Number(result.changes ?? 0)
  }

  private addAgentEvent(missionId: string, kind: string, message: string): void {
    this.db
      .prepare('INSERT INTO agent_events (id, mission_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), missionId, kind, message, new Date().toISOString())
  }
}

type AgentMissionRow = {
  id: string
  title: string
  prompt: string
  status: string
  iteration: number
  tool_calls: number
  summary: string | null
  error: string | null
  created_at: string
  updated_at: string
}

function mapAgentMission(row: AgentMissionRow): AgentMissionSummary {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    status: isMissionStatus(row.status) ? row.status : 'failed',
    iteration: row.iteration,
    toolCalls: row.tool_calls,
    summary: row.summary,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
