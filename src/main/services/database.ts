import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  canTransition,
  chatTitleFromPrompt,
  isMissionStatus,
  missionTitle,
  normalizeToolExecutionState,
  type AgentChatSummary,
  type AgentChatTranscript,
  type AgentMissionSummary,
  type AgentOperationSummary,
  type AgentTranscript,
  type MissionStatus,
  type OperationKind,
  type OperationStatus,
  type ToolExecutionState
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
    )`,
  `CREATE TABLE agent_operations (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      to_path TEXT,
      explanation TEXT NOT NULL,
      original_text TEXT,
      proposed_text TEXT,
      base_hash TEXT,
      applied_hash TEXT,
      content_fingerprint TEXT NOT NULL,
      unified_diff TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      file_change_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )`,
  `ALTER TABLE agent_operations ADD COLUMN source_operation_id TEXT`,
  `ALTER TABLE file_changes ADD COLUMN review_status TEXT NOT NULL DEFAULT 'open'`,
  `ALTER TABLE file_changes ADD COLUMN applied_hash TEXT`,
  `CREATE TABLE agent_chats (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      title TEXT NOT NULL,
      title_locked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )`,
  `CREATE INDEX agent_chats_workspace_updated ON agent_chats (workspace_path, updated_at DESC)`,
  `ALTER TABLE agent_missions ADD COLUMN chat_id TEXT`,
  `CREATE INDEX agent_missions_chat_created ON agent_missions (chat_id, created_at ASC)`,
  `ALTER TABLE file_changes ADD COLUMN chat_id TEXT`,
  `CREATE INDEX file_changes_chat_status ON file_changes (chat_id, review_status, created_at DESC)`,
  `CREATE TABLE agent_commands (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      explanation TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX agent_commands_mission_created ON agent_commands (mission_id, created_at ASC)`
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
    this.ensureLegacyChats()
  }

  /** One legacy chat per existing mission that has no chat_id. Never merges unrelated missions. */
  private ensureLegacyChats(): void {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_path, title, prompt, created_at, updated_at
         FROM agent_missions
         WHERE chat_id IS NULL
         ORDER BY created_at ASC`
      )
      .all() as Array<{
      id: string
      workspace_path: string
      title: string
      prompt: string
      created_at: string
      updated_at: string
    }>
    if (rows.length > 0) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const insert = this.db.prepare(
          `INSERT INTO agent_chats (id, workspace_path, title, title_locked, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, 0, ?, ?, NULL)`
        )
        const link = this.db.prepare('UPDATE agent_missions SET chat_id = ? WHERE id = ? AND chat_id IS NULL')
        for (const row of rows) {
          const chatId = crypto.randomUUID()
          insert.run(chatId, row.workspace_path, chatTitleFromPrompt(row.prompt || row.title), row.created_at, row.updated_at)
          link.run(chatId, row.id)
        }
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    this.backfillFileChangeChats()
  }

  /** Attach orphan file_changes to chats via agent_operations → agent_missions when possible. */
  private backfillFileChangeChats(): void {
    this.db
      .prepare(
        `UPDATE file_changes
         SET chat_id = (
           SELECT agent_missions.chat_id
           FROM agent_operations
           JOIN agent_missions ON agent_missions.id = agent_operations.mission_id
           WHERE agent_operations.file_change_id = file_changes.id
             AND agent_missions.chat_id IS NOT NULL
           LIMIT 1
         )
         WHERE chat_id IS NULL
           AND EXISTS (
             SELECT 1
             FROM agent_operations
             JOIN agent_missions ON agent_missions.id = agent_operations.mission_id
             WHERE agent_operations.file_change_id = file_changes.id
               AND agent_missions.chat_id IS NOT NULL
           )`
      )
      .run()
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
    chatId?: string | null
    relativePath: string
    changeType: string
    reverseText: string | null
    appliedHash?: string | null
  }): string {
    const id = crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO file_changes (
           id, mission_id, relative_path, change_type, reverse_text, created_at, review_status, applied_hash, chat_id
         ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(
        id,
        input.missionId,
        input.relativePath,
        input.changeType,
        input.reverseText,
        new Date().toISOString(),
        input.appliedHash ?? null,
        input.chatId ?? null
      )
    if (input.missionId) {
      this.addEvent(input.missionId, 'file', `${input.changeType} ${input.relativePath}`)
    }
    return id
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

  listFileChanges(
    limit = 50,
    status: 'open' | 'kept' | 'undone' | 'all' = 'open',
    chatId?: string | null
  ): FileChangeRecord[] {
    if (chatId) {
      const rows =
        status === 'all'
          ? (this.db
              .prepare(
                `SELECT id, mission_id, relative_path, change_type, reverse_text, created_at, review_status, applied_hash, chat_id
                 FROM file_changes WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`
              )
              .all(chatId, limit) as FileChangeRow[])
          : (this.db
              .prepare(
                `SELECT id, mission_id, relative_path, change_type, reverse_text, created_at, review_status, applied_hash, chat_id
                 FROM file_changes WHERE chat_id = ? AND review_status = ? ORDER BY created_at DESC LIMIT ?`
              )
              .all(chatId, status, limit) as FileChangeRow[])
      return rows.map(mapFileChange)
    }
    const rows =
      status === 'all'
        ? (this.db
            .prepare(
              `SELECT id, mission_id, relative_path, change_type, reverse_text, created_at, review_status, applied_hash, chat_id
               FROM file_changes ORDER BY created_at DESC LIMIT ?`
            )
            .all(limit) as FileChangeRow[])
        : (this.db
            .prepare(
              `SELECT id, mission_id, relative_path, change_type, reverse_text, created_at, review_status, applied_hash, chat_id
               FROM file_changes WHERE review_status = ? ORDER BY created_at DESC LIMIT ?`
            )
            .all(status, limit) as FileChangeRow[])
    return rows.map(mapFileChange)
  }

  getFileChangeRecord(id: string): FileChangeDetailRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, mission_id, relative_path, change_type, reverse_text, created_at, review_status, applied_hash
         FROM file_changes WHERE id = ?`
      )
      .get(id) as FileChangeRow | undefined
    return row ? mapFileChangeDetail(row) : null
  }

  markFileChangesReviewStatus(ids: string[], status: 'kept' | 'undone' | 'open'): number {
    if (ids.length === 0) {
      return 0
    }
    const statement = this.db.prepare(
      `UPDATE file_changes SET review_status = ? WHERE id = ? AND review_status = 'open'`
    )
    let changed = 0
    for (const id of ids) {
      const result = statement.run(status, id)
      changed += Number(result.changes ?? 0)
    }
    return changed
  }

  createAgentChat(workspacePath: string, title = 'New chat'): AgentChatSummary {
    const now = new Date().toISOString()
    const chat: AgentChatSummary = {
      id: crypto.randomUUID(),
      workspacePath,
      title: chatTitleFromPrompt(title),
      titleLocked: false,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestMissionStatus: null
    }
    this.db
      .prepare(
        `INSERT INTO agent_chats (id, workspace_path, title, title_locked, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, 0, ?, ?, NULL)`
      )
      .run(chat.id, workspacePath, chat.title, chat.createdAt, chat.updatedAt)
    return chat
  }

  getAgentChat(id: string): AgentChatSummary | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_path, title, title_locked, created_at, updated_at, archived_at
         FROM agent_chats WHERE id = ?`
      )
      .get(id) as AgentChatRow | undefined
    return row ? this.mapAgentChat(row) : null
  }

  listAgentChatsForWorkspace(workspacePath: string, limit = 40): AgentChatSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_path, title, title_locked, created_at, updated_at, archived_at
         FROM agent_chats
         WHERE workspace_path = ? AND archived_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(workspacePath, limit) as AgentChatRow[]
    return rows.map((row) => this.mapAgentChat(row))
  }

  latestAgentChat(workspacePath: string): AgentChatSummary | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_path, title, title_locked, created_at, updated_at, archived_at
         FROM agent_chats
         WHERE workspace_path = ? AND archived_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(workspacePath) as AgentChatRow | undefined
    return row ? this.mapAgentChat(row) : null
  }

  agentChatBelongsToWorkspace(chatId: string, workspacePath: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM agent_chats WHERE id = ? AND workspace_path = ?')
      .get(chatId, workspacePath) as { ok: number } | undefined
    return Boolean(row)
  }

  touchAgentChat(chatId: string): void {
    this.db.prepare('UPDATE agent_chats SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), chatId)
  }

  renameAgentChat(chatId: string, title: string): AgentChatSummary | null {
    const current = this.getAgentChat(chatId)
    if (!current || current.archivedAt) {
      return null
    }
    const next = chatTitleFromPrompt(title)
    this.db
      .prepare('UPDATE agent_chats SET title = ?, title_locked = 1, updated_at = ? WHERE id = ?')
      .run(next, new Date().toISOString(), chatId)
    return this.getAgentChat(chatId)
  }

  archiveAgentChat(chatId: string): AgentChatSummary | null {
    const current = this.getAgentChat(chatId)
    if (!current) {
      return null
    }
    if (current.archivedAt) {
      return current
    }
    const now = new Date().toISOString()
    this.db.prepare('UPDATE agent_chats SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, chatId)
    return this.getAgentChat(chatId)
  }

  selectedChatSettingKey(workspacePath: string): string {
    return `selectedChat:${workspacePath}`
  }

  getSelectedChatId(workspacePath: string): string | null {
    return this.getSetting(this.selectedChatSettingKey(workspacePath))
  }

  setSelectedChatId(workspacePath: string, chatId: string | null): void {
    const key = this.selectedChatSettingKey(workspacePath)
    if (!chatId) {
      this.deleteSetting(key)
      return
    }
    this.setSetting(key, chatId)
  }

  listAgentMissionsForChat(chatId: string): AgentMissionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, chat_id, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at
         FROM agent_missions WHERE chat_id = ? ORDER BY created_at ASC`
      )
      .all(chatId) as AgentMissionRow[]
    return rows.map(mapAgentMission)
  }

  agentChatTranscript(chatId: string): AgentChatTranscript | null {
    const chat = this.getAgentChat(chatId)
    if (!chat) {
      return null
    }
    const missions = this.listAgentMissionsForChat(chatId)
    const turns = missions
      .map((mission) => this.agentTranscript(mission.id))
      .filter((item): item is AgentTranscript => Boolean(item))
    return { chat, missions, turns }
  }

  createAgentMission(workspacePath: string, prompt: string, chatId?: string): AgentMissionSummary {
    const resolvedChatId = chatId ?? this.createAgentChat(workspacePath, prompt).id
    const chat = this.getAgentChat(resolvedChatId)
    if (!chat || chat.workspacePath !== workspacePath) {
      throw new Error('Chat does not belong to this workspace')
    }
    if (chat.archivedAt) {
      throw new Error('Chat is archived')
    }
    const now = new Date().toISOString()
    const mission: AgentMissionSummary = {
      id: crypto.randomUUID(),
      chatId: resolvedChatId,
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
           id, workspace_path, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at, chat_id
         ) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?, ?)`
      )
      .run(
        mission.id,
        workspacePath,
        mission.title,
        mission.prompt,
        mission.status,
        mission.createdAt,
        mission.updatedAt,
        resolvedChatId
      )
    if (!chat.titleLocked && chat.title === 'New chat') {
      this.db
        .prepare('UPDATE agent_chats SET title = ?, updated_at = ? WHERE id = ? AND title_locked = 0')
        .run(chatTitleFromPrompt(prompt), now, resolvedChatId)
    } else {
      this.touchAgentChat(resolvedChatId)
    }
    this.addAgentEvent(mission.id, 'status', 'queued')
    return mission
  }

  getAgentMission(id: string): AgentMissionSummary | null {
    const row = this.db
      .prepare(
        `SELECT id, chat_id, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at
         FROM agent_missions WHERE id = ?`
      )
      .get(id) as AgentMissionRow | undefined
    return row ? mapAgentMission(row) : null
  }

  activeAgentMission(): AgentMissionSummary | null {
    const row = this.db
      .prepare(
        `SELECT id, chat_id, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at
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
        `SELECT id, chat_id, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at
         FROM agent_missions ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as AgentMissionRow[]
    return rows.map(mapAgentMission)
  }

  private mapAgentChat(row: AgentChatRow): AgentChatSummary {
    const latest = this.db
      .prepare(
        `SELECT status FROM agent_missions WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(row.id) as { status: string } | undefined
    return {
      id: row.id,
      workspacePath: row.workspace_path,
      title: row.title,
      titleLocked: Number(row.title_locked) === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      latestMissionStatus: latest && isMissionStatus(latest.status) ? latest.status : null
    }
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
    if (current.chatId) {
      this.touchAgentChat(current.chatId)
    }
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
    state: ToolExecutionState
    output: string
  }): void {
    const now = new Date().toISOString()
    const existing = this.db
      .prepare('SELECT id FROM agent_tool_calls WHERE mission_id = ? AND call_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(input.missionId, input.callId) as { id: string } | undefined
    if (existing) {
      this.db
        .prepare('UPDATE agent_tool_calls SET status = ?, output = ?, arguments = ? WHERE id = ?')
        .run(input.state, input.output, input.argumentsText, existing.id)
    } else {
      this.db
        .prepare(
          `INSERT INTO agent_tool_calls (id, mission_id, call_id, name, arguments, status, output, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(crypto.randomUUID(), input.missionId, input.callId, input.name, input.argumentsText, input.state, input.output, now)
      this.db.prepare('UPDATE agent_missions SET tool_calls = tool_calls + 1, updated_at = ? WHERE id = ?').run(now, input.missionId)
    }
    this.addAgentEvent(input.missionId, 'tool', `${input.state} ${input.name}`)
  }

  createAgentOperation(input: {
    id: string
    missionId: string
    callId: string
    kind: OperationKind
    path: string
    toPath: string | null
    explanation: string
    originalText: string | null
    proposedText: string | null
    baseHash: string | null
    contentFingerprint: string
    unifiedDiff: string
    sourceOperationId?: string | null
  }): AgentOperationSummary {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO agent_operations (
           id, mission_id, call_id, kind, path, to_path, explanation,
           original_text, proposed_text, base_hash, applied_hash, content_fingerprint,
           unified_diff, status, error, file_change_id, created_at, resolved_at, source_operation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'pending', NULL, NULL, ?, NULL, ?)`
      )
      .run(
        input.id,
        input.missionId,
        input.callId,
        input.kind,
        input.path,
        input.toPath,
        input.explanation,
        input.originalText,
        input.proposedText,
        input.baseHash,
        input.contentFingerprint,
        input.unifiedDiff,
        now,
        input.sourceOperationId ?? null
      )
    this.addAgentEvent(input.missionId, 'operation', `pending ${input.kind} ${input.path}`)
    const created = this.getAgentOperation(input.id)
    if (!created) {
      throw new Error('Failed to persist agent operation')
    }
    return created
  }

  getAgentOperation(id: string): AgentOperationSummary | null {
    const row = this.db.prepare('SELECT * FROM agent_operations WHERE id = ?').get(id) as AgentOperationRow | undefined
    return row ? mapAgentOperation(row) : null
  }

  getAgentOperationRecord(id: string): AgentOperationRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_operations WHERE id = ?').get(id) as AgentOperationRow | undefined
    return row ? mapAgentOperationRecord(row) : null
  }

  listAgentOperations(missionId: string): AgentOperationSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_operations WHERE mission_id = ? ORDER BY created_at ASC')
      .all(missionId) as AgentOperationRow[]
    return rows.map(mapAgentOperation)
  }

  listPendingAgentOperations(missionId: string): AgentOperationSummary[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_operations WHERE mission_id = ? AND status = 'pending' ORDER BY created_at ASC`)
      .all(missionId) as AgentOperationRow[]
    return rows.map(mapAgentOperation)
  }

  listAgentMissionsForWorkspace(workspacePath: string, limit = 20): AgentMissionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, chat_id, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at
         FROM agent_missions WHERE workspace_path = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(workspacePath, limit) as AgentMissionRow[]
    return rows.map(mapAgentMission)
  }

  agentMissionBelongsToWorkspace(missionId: string, workspacePath: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM agent_missions WHERE id = ? AND workspace_path = ?')
      .get(missionId, workspacePath) as { ok: number } | undefined
    return Boolean(row)
  }

  latestAgentMission(workspacePath?: string | null): AgentMissionSummary | null {
    if (workspacePath) {
      const row = this.db
        .prepare(
          `SELECT id, chat_id, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at
           FROM agent_missions WHERE workspace_path = ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(workspacePath) as AgentMissionRow | undefined
      return row ? mapAgentMission(row) : null
    }
    const row = this.db
      .prepare(
        `SELECT id, chat_id, title, prompt, status, iteration, tool_calls, summary, error, created_at, updated_at
         FROM agent_missions ORDER BY created_at DESC LIMIT 1`
      )
      .get() as AgentMissionRow | undefined
    return row ? mapAgentMission(row) : null
  }

  listWorkspaceOperations(input: {
    workspacePath: string
    path?: string
    kind?: OperationKind
    status?: OperationStatus
    limit?: number
  }): AgentOperationSummary[] {
    const clauses = ['m.workspace_path = ?']
    const params: Array<string | number> = [input.workspacePath]
    if (input.path) {
      clauses.push('(o.path = ? OR o.to_path = ?)')
      params.push(input.path, input.path)
    }
    if (input.kind) {
      clauses.push('o.kind = ?')
      params.push(input.kind)
    }
    if (input.status) {
      clauses.push('o.status = ?')
      params.push(input.status)
    }
    params.push(Math.min(Math.max(input.limit ?? 40, 1), 100))
    const rows = this.db
      .prepare(
        `SELECT o.*
         FROM agent_operations o
         INNER JOIN agent_missions m ON m.id = o.mission_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY o.created_at DESC
         LIMIT ?`
      )
      .all(...params) as AgentOperationRow[]
    return rows.map(mapAgentOperation)
  }

  /** Atomically claim a pending operation for approval. Returns null if not claimable. */
  claimAgentOperation(missionId: string, operationId: string): AgentOperationRecord | null {
    const now = new Date().toISOString()
    const result = this.db
      .prepare(
        `UPDATE agent_operations
         SET status = 'approved', resolved_at = ?
         WHERE id = ? AND mission_id = ? AND status = 'pending'`
      )
      .run(now, operationId, missionId)
    if (Number(result.changes ?? 0) !== 1) {
      return null
    }
    return this.getAgentOperationRecord(operationId)
  }

  rejectAgentOperation(missionId: string, operationId: string): AgentOperationSummary | null {
    const now = new Date().toISOString()
    const result = this.db
      .prepare(
        `UPDATE agent_operations
         SET status = 'rejected', resolved_at = ?, error = ?
         WHERE id = ? AND mission_id = ? AND status = 'pending'`
      )
      .run(now, 'The user rejected this proposal.', operationId, missionId)
    if (Number(result.changes ?? 0) !== 1) {
      return null
    }
    return this.getAgentOperation(operationId)
  }

  cancelPendingAgentOperations(missionId: string): number {
    const now = new Date().toISOString()
    const result = this.db
      .prepare(
        `UPDATE agent_operations
         SET status = 'cancelled', resolved_at = ?, error = ?
         WHERE mission_id = ? AND status = 'pending'`
      )
      .run(now, 'The mission was cancelled.', missionId)
    return Number(result.changes ?? 0)
  }

  finalizeAgentOperation(
    operationId: string,
    status: Extract<OperationStatus, 'applied' | 'failed' | 'stale'>,
    patch: { error?: string | null; appliedHash?: string | null; fileChangeId?: string | null }
  ): AgentOperationSummary | null {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE agent_operations
         SET status = ?,
             error = COALESCE(?, error),
             applied_hash = COALESCE(?, applied_hash),
             file_change_id = COALESCE(?, file_change_id),
             resolved_at = COALESCE(resolved_at, ?)
         WHERE id = ? AND status IN ('approved', 'pending')`
      )
      .run(status, patch.error ?? null, patch.appliedHash ?? null, patch.fileChangeId ?? null, now, operationId)
    return this.getAgentOperation(operationId)
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
        state: normalizeToolExecutionState(row.status),
        output: row.output,
        createdAt: row.created_at
      })),
      operations: this.listAgentOperations(id)
    }
  }

  createAgentCommand(input: {
    id: string
    missionId: string
    callId: string
    command: string
    args: string[]
    workingDirectory: string
    explanation: string
    status: string
  }): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO agent_commands (
           id, mission_id, call_id, command, args, working_directory, explanation, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.missionId,
        input.callId,
        input.command,
        JSON.stringify(input.args),
        input.workingDirectory,
        input.explanation,
        input.status,
        now
      )
    this.addAgentEvent(input.missionId, 'command', `${input.status} ${input.command}`)
  }

  updateAgentCommand(
    id: string,
    patch: {
      status: string
      exitCode?: number | null
      stdout?: string | null
      stderr?: string | null
      error?: string | null
      startedAt?: string | null
      finishedAt?: string | null
    }
  ): void {
    this.db
      .prepare(
        `UPDATE agent_commands
         SET status = ?,
             exit_code = COALESCE(?, exit_code),
             stdout = COALESCE(?, stdout),
             stderr = COALESCE(?, stderr),
             error = COALESCE(?, error),
             started_at = COALESCE(?, started_at),
             finished_at = COALESCE(?, finished_at)
         WHERE id = ?`
      )
      .run(
        patch.status,
        patch.exitCode ?? null,
        patch.stdout ?? null,
        patch.stderr ?? null,
        patch.error ?? null,
        patch.startedAt ?? null,
        patch.finishedAt ?? null,
        id
      )
  }

  listAgentCommands(missionId: string): Array<{
    id: string
    missionId: string
    callId: string
    command: string
    args: string
    workingDirectory: string
    explanation: string
    status: string
    exitCode: number | null
    stdout: string | null
    stderr: string | null
    error: string | null
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, mission_id, call_id, command, args, working_directory, explanation, status, exit_code, stdout, stderr, error
         FROM agent_commands WHERE mission_id = ? ORDER BY created_at ASC`
      )
      .all(missionId) as Array<{
      id: string
      mission_id: string
      call_id: string
      command: string
      args: string
      working_directory: string
      explanation: string
      status: string
      exit_code: number | null
      stdout: string | null
      stderr: string | null
      error: string | null
    }>
    return rows.map((row) => ({
      id: row.id,
      missionId: row.mission_id,
      callId: row.call_id,
      command: row.command,
      args: row.args,
      workingDirectory: row.working_directory,
      explanation: row.explanation,
      status: row.status,
      exitCode: row.exit_code,
      stdout: row.stdout,
      stderr: row.stderr,
      error: row.error
    }))
  }

  interruptAgentMissions(): number {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE agent_commands
         SET status = 'cancelled',
             error = COALESCE(error, 'The mission was interrupted because KERN exited.'),
             finished_at = COALESCE(finished_at, ?)
         WHERE status IN ('queued', 'running')`
      )
      .run(now)
    this.db
      .prepare(
        `UPDATE agent_operations
         SET status = 'cancelled',
             error = COALESCE(error, 'The mission was interrupted because KERN exited.'),
             resolved_at = COALESCE(resolved_at, ?)
         WHERE status = 'pending'`
      )
      .run(now)
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
  chat_id?: string | null
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

type AgentChatRow = {
  id: string
  workspace_path: string
  title: string
  title_locked: number
  created_at: string
  updated_at: string
  archived_at: string | null
}

function mapAgentMission(row: AgentMissionRow): AgentMissionSummary {
  return {
    id: row.id,
    chatId: row.chat_id ?? null,
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

type AgentOperationRow = {
  id: string
  mission_id: string
  call_id: string
  kind: string
  path: string
  to_path: string | null
  explanation: string
  original_text: string | null
  proposed_text: string | null
  base_hash: string | null
  applied_hash: string | null
  content_fingerprint: string
  unified_diff: string
  status: string
  error: string | null
  file_change_id: string | null
  source_operation_id?: string | null
  created_at: string
  resolved_at: string | null
}

export type AgentOperationRecord = AgentOperationSummary & {
  originalText: string | null
  proposedText: string | null
  baseHash: string | null
  appliedHash: string | null
  fileChangeId: string | null
}

function isOperationKind(value: string): value is OperationKind {
  return value === 'create' || value === 'edit' || value === 'delete' || value === 'rename' || value === 'restore'
}

function isOperationStatus(value: string): value is OperationStatus {
  return (
    value === 'pending' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'applied' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'stale'
  )
}

function mapAgentOperation(row: AgentOperationRow): AgentOperationSummary {
  const kind = isOperationKind(row.kind) ? row.kind : 'edit'
  return {
    id: row.id,
    missionId: row.mission_id,
    callId: row.call_id,
    kind,
    path: row.path,
    toPath: row.to_path,
    explanation: row.explanation,
    status: isOperationStatus(row.status) ? row.status : 'failed',
    unifiedDiff: row.unified_diff,
    destructive: kind === 'delete' || kind === 'rename' || kind === 'restore',
    error: row.error,
    contentFingerprint: row.content_fingerprint,
    sourceOperationId: row.source_operation_id ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  }
}

function mapAgentOperationRecord(row: AgentOperationRow): AgentOperationRecord {
  return {
    ...mapAgentOperation(row),
    originalText: row.original_text,
    proposedText: row.proposed_text,
    baseHash: row.base_hash,
    appliedHash: row.applied_hash,
    fileChangeId: row.file_change_id
  }
}

type FileChangeRow = {
  id: string
  mission_id: string | null
  relative_path: string
  change_type: string
  reverse_text: string | null
  created_at: string
  review_status?: string | null
  applied_hash?: string | null
  chat_id?: string | null
}

export type FileChangeDetailRecord = FileChangeRecord & {
  reverseText: string | null
  appliedHash: string | null
}

function mapFileChange(row: FileChangeRow): FileChangeRecord {
  const reviewStatus =
    row.review_status === 'kept' || row.review_status === 'undone' || row.review_status === 'open'
      ? row.review_status
      : 'open'
  return {
    id: row.id,
    missionId: row.mission_id,
    chatId: row.chat_id ?? null,
    relativePath: row.relative_path,
    changeType: row.change_type,
    createdAt: row.created_at,
    hasReverse: row.reverse_text !== null,
    reviewStatus
  }
}

function mapFileChangeDetail(row: FileChangeRow): FileChangeDetailRecord {
  return {
    ...mapFileChange(row),
    reverseText: row.reverse_text,
    appliedHash: row.applied_hash ?? null
  }
}
