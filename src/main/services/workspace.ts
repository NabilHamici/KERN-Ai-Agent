import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { unifiedDiff } from '../../shared/diff.ts'
import type { DirectoryEntry, FileChangeRecord, FileChangeReviewItem, MissionRecord, WorkspaceInfo } from '../../shared/ipc.ts'
import { PathJailError, normalizeRelative, resolveEntry, resolveInside, workspaceRoot } from '../security/pathJail.ts'
import { writeFileAtomic } from './atomicWrite.ts'
import type { MissionDatabase } from './database.ts'

function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

const MAX_READ_BYTES = 2_000_000
const MAX_REVERSE_BYTES = 512_000
const WORKSPACE_SETTING = 'workspacePath'
const NODE_MODULES_LIST_CAP = 200

export class WorkspaceService {
  private root: string | null = null
  private missionId: string | null = null
  private chatId: string | null = null
  private readonly database: MissionDatabase

  constructor(database: MissionDatabase) {
    this.database = database
  }

  current(): WorkspaceInfo | null {
    if (!this.root) {
      return null
    }
    return { path: this.root, name: path.basename(this.root) }
  }

  sessionMissionId(): string | null {
    return this.missionId
  }

  activeChatId(): string | null {
    return this.chatId
  }

  setActiveChatId(chatId: string | null): void {
    this.chatId = chatId
  }

  restore(): WorkspaceInfo | null {
    const saved = this.database.getSetting(WORKSPACE_SETTING)
    if (!saved) {
      return null
    }
    try {
      return this.open(saved)
    } catch {
      this.database.deleteSetting(WORKSPACE_SETTING)
      this.root = null
      this.missionId = null
      this.chatId = null
      return null
    }
  }

  open(folder: string): WorkspaceInfo {
    const root = workspaceRoot(folder)
    this.root = root
    this.database.setSetting(WORKSPACE_SETTING, root)
    const mission = this.database.createMission(root, path.basename(root))
    this.missionId = mission.id
    const selected = this.database.getSelectedChatId(root)
    if (selected && this.database.agentChatBelongsToWorkspace(selected, root)) {
      const chat = this.database.getAgentChat(selected)
      this.chatId = chat && !chat.archivedAt ? selected : null
    } else {
      this.chatId = this.database.latestAgentChat(root)?.id ?? null
    }
    if (this.chatId) {
      this.database.setSelectedChatId(root, this.chatId)
    }
    return { path: root, name: path.basename(root) }
  }

  list(relativePath: string): DirectoryEntry[] {
    const root = this.requireRoot()
    const directory = resolveInside(root, relativePath)
    if (!fs.statSync(directory).isDirectory()) {
      throw new PathJailError('Not a directory')
    }
    const base = normalizeRelative(relativePath)
    const names = fs.readdirSync(directory)
    const entries: DirectoryEntry[] = names.map((name) => {
      const relative = base === '.' ? name : `${base}/${name}`
      try {
        const resolved = resolveInside(root, relative)
        const kind = fs.statSync(resolved).isDirectory() ? 'directory' : 'file'
        return { name, relativePath: relative, kind, blocked: false }
      } catch (error) {
        if (error instanceof PathJailError) {
          return { name, relativePath: relative, kind: 'file' as const, blocked: true }
        }
        throw error
      }
    })
    entries.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1
      }
      return left.name.localeCompare(right.name)
    })
    // Cap listings inside node_modules (lazy single entry at parents; deep lists stay bounded).
    const parts = base.split('/').filter(Boolean)
    if (parts.includes('node_modules') && entries.length > NODE_MODULES_LIST_CAP) {
      const visible = entries.slice(0, NODE_MODULES_LIST_CAP)
      const omitted = entries.length - NODE_MODULES_LIST_CAP
      visible.push({
        name: `… ${omitted} more`,
        relativePath: `${base}/.__kern_more__`,
        kind: 'file',
        blocked: true
      })
      return visible
    }
    return entries
  }

  read(relativePath: string): string {
    const root = this.requireRoot()
    const target = resolveInside(root, relativePath)
    const stat = fs.statSync(target)
    if (!stat.isFile()) {
      throw new PathJailError('Not a file')
    }
    if (stat.size > MAX_READ_BYTES) {
      throw new PathJailError('File is too large to open')
    }
    const bytes = fs.readFileSync(target)
    if (bytes.includes(0)) {
      throw new PathJailError('Binary files cannot be opened in the editor')
    }
    return bytes.toString('utf8')
  }

  write(relativePath: string, content: string): void {
    const root = this.requireRoot()
    const entry = resolveEntry(root, relativePath)
    if (entry.lexical === entry.root) {
      throw new PathJailError('Refusing to overwrite the workspace root')
    }
    const reverseText = this.previousText(root, relativePath)
    const target = entry.exists ? resolveInside(root, relativePath) : entry.lexical
    if (entry.exists && !fs.statSync(target).isFile()) {
      throw new PathJailError('Not a file')
    }
    writeFileAtomic(target, content)
    this.database.recordFileChange({
      missionId: this.missionId,
      chatId: this.chatId,
      relativePath: normalizeRelative(relativePath),
      changeType: reverseText === null && !entry.exists ? 'create' : 'write',
      reverseText,
      appliedHash: contentHash(content)
    })
  }

  createFile(relativePath: string, content = ''): void {
    const root = this.requireRoot()
    const entry = resolveEntry(root, relativePath)
    if (entry.exists) {
      throw new PathJailError('Path already exists')
    }
    fs.mkdirSync(path.dirname(entry.lexical), { recursive: true })
    writeFileAtomic(entry.lexical, content)
    this.database.recordFileChange({
      missionId: this.missionId,
      chatId: this.chatId,
      relativePath: normalizeRelative(relativePath),
      changeType: 'create',
      reverseText: null,
      appliedHash: contentHash(content)
    })
  }

  createDirectory(relativePath: string): void {
    const root = this.requireRoot()
    const entry = resolveEntry(root, relativePath)
    if (entry.lexical === entry.root) {
      throw new PathJailError('Path is invalid')
    }
    if (entry.exists) {
      throw new PathJailError('Path already exists')
    }
    fs.mkdirSync(entry.lexical)
    this.database.recordFileChange({
      missionId: this.missionId,
      chatId: this.chatId,
      relativePath: normalizeRelative(relativePath),
      changeType: 'create',
      reverseText: null
    })
  }

  rename(from: string, to: string, confirm: boolean): void {
    if (confirm !== true) {
      throw new PathJailError('Confirmation is required')
    }
    const root = this.requireRoot()
    const source = resolveEntry(root, from)
    const destination = resolveEntry(root, to)
    if (!source.exists) {
      throw new PathJailError('Path does not exist')
    }
    if (source.lexical === source.root || destination.lexical === destination.root) {
      throw new PathJailError('Refusing to rename the workspace root')
    }
    if (destination.exists) {
      throw new PathJailError('Path already exists')
    }
    const beforeHash = source.exists && !source.isSymbolicLink ? this.hashIfFile(root, from) : null
    fs.renameSync(source.lexical, destination.lexical)
    this.database.recordFileChange({
      missionId: this.missionId,
      chatId: this.chatId,
      relativePath: normalizeRelative(from),
      changeType: 'rename',
      reverseText: normalizeRelative(to),
      appliedHash: beforeHash
    })
  }

  remove(relativePath: string, confirm: boolean): void {
    if (confirm !== true) {
      throw new PathJailError('Confirmation is required')
    }
    const root = this.requireRoot()
    const entry = resolveEntry(root, relativePath)
    if (entry.lexical === entry.root) {
      throw new PathJailError('Refusing to delete the workspace root')
    }
    if (!entry.exists) {
      throw new PathJailError('Path does not exist')
    }
    const reverseText = entry.isSymbolicLink ? null : this.previousText(root, relativePath)
    const appliedHash = reverseText === null ? null : contentHash(reverseText)
    if (entry.isSymbolicLink) {
      fs.unlinkSync(entry.lexical)
    } else {
      const stat = fs.lstatSync(entry.lexical)
      if (stat.isDirectory()) {
        fs.rmSync(entry.lexical, { recursive: true, force: false })
      } else {
        fs.unlinkSync(entry.lexical)
      }
    }
    this.database.recordFileChange({
      missionId: this.missionId,
      chatId: this.chatId,
      relativePath: normalizeRelative(relativePath),
      changeType: 'delete',
      reverseText,
      appliedHash
    })
  }

  listMissions(limit?: number): MissionRecord[] {
    return this.database.listMissions(limit)
  }

  listFileChanges(
    limit?: number,
    status: 'open' | 'kept' | 'undone' | 'all' = 'open',
    chatId?: string | null
  ): FileChangeRecord[] {
    return this.database.listFileChanges(limit, status, chatId === undefined ? this.chatId : chatId)
  }

  keepFileChanges(ids?: string[]): { kept: string[]; skipped: Array<{ id: string; path: string; error: string }> } {
    const targets =
      ids && ids.length > 0
        ? ids
        : this.database.listFileChanges(200, 'open', this.chatId).map((item) => item.id)
    const kept: string[] = []
    const skipped: Array<{ id: string; path: string; error: string }> = []
    for (const id of targets) {
      const record = this.database.getFileChangeRecord(id)
      if (!record) {
        skipped.push({ id, path: '', error: 'Change not found.' })
        continue
      }
      if (record.reviewStatus !== 'open') {
        skipped.push({ id, path: record.relativePath, error: `Change is already ${record.reviewStatus}.` })
        continue
      }
      const marked = this.database.markFileChangesReviewStatus([id], 'kept')
      if (marked === 1) {
        kept.push(id)
      } else {
        skipped.push({ id, path: record.relativePath, error: 'Change could not be marked as kept.' })
      }
    }
    return { kept, skipped }
  }

  undoFileChanges(ids?: string[]): {
    undone: string[]
    failed: Array<{ id: string; path: string; error: string }>
  } {
    const targets =
      ids && ids.length > 0
        ? ids
        : this.database.listFileChanges(200, 'open', this.chatId).map((item) => item.id)
    const undone: string[] = []
    const failed: Array<{ id: string; path: string; error: string }> = []
    for (const id of targets) {
      try {
        this.undoOneFileChange(id)
        undone.push(id)
      } catch (error) {
        const record = this.database.getFileChangeRecord(id)
        failed.push({
          id,
          path: record?.relativePath ?? '',
          error: error instanceof PathJailError || error instanceof Error ? error.message : 'Undo failed.'
        })
      }
    }
    return { undone, failed }
  }

  reviewFileChange(id: string): FileChangeReviewItem {
    const record = this.database.getFileChangeRecord(id)
    if (!record) {
      throw new PathJailError('Change not found.')
    }
    const root = this.requireRoot()
    let diff = ''
    let error: string | null = null
    try {
      if (record.changeType === 'rename') {
        const toPath = record.reverseText
        const current = toPath ? this.previousText(root, toPath) : null
        diff = unifiedDiff(record.relativePath, current, current, toPath)
      } else if (record.changeType === 'delete') {
        diff = unifiedDiff(record.relativePath, record.reverseText, null)
      } else if (record.changeType === 'create') {
        const current = this.previousText(root, record.relativePath)
        diff = unifiedDiff(record.relativePath, null, current)
      } else {
        const current = this.previousText(root, record.relativePath)
        diff = unifiedDiff(record.relativePath, record.reverseText, current)
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to build review diff.'
      diff = `Review unavailable for ${record.relativePath}`
    }
    return {
      id: record.id,
      relativePath: record.relativePath,
      changeType: record.changeType,
      reviewStatus: record.reviewStatus,
      hasReverse: record.hasReverse,
      unifiedDiff: diff.slice(0, 16_000),
      error
    }
  }

  private undoOneFileChange(id: string): void {
    const record = this.database.getFileChangeRecord(id)
    if (!record) {
      throw new PathJailError('Change not found.')
    }
    if (record.reviewStatus !== 'open') {
      throw new PathJailError(`Change is already ${record.reviewStatus}.`)
    }
    const root = this.requireRoot()
    if (record.changeType === 'create') {
      this.assertCurrentHash(root, record.relativePath, record.appliedHash)
      this.removeSilent(record.relativePath)
    } else if (record.changeType === 'write') {
      if (record.reverseText === null) {
        throw new PathJailError('No reverse snapshot is available for this write.')
      }
      this.assertCurrentHash(root, record.relativePath, record.appliedHash)
      this.writeSilent(record.relativePath, record.reverseText)
    } else if (record.changeType === 'delete') {
      if (record.reverseText === null) {
        throw new PathJailError('No reverse snapshot is available for this delete.')
      }
      const entry = resolveEntry(root, record.relativePath)
      if (entry.exists) {
        throw new PathJailError('A file exists at the restore path. Undo refused.')
      }
      this.writeSilent(record.relativePath, record.reverseText)
    } else if (record.changeType === 'rename') {
      if (!record.reverseText) {
        throw new PathJailError('Rename reverse path is missing.')
      }
      const toPath = record.reverseText
      this.assertCurrentHash(root, toPath, record.appliedHash)
      const original = resolveEntry(root, record.relativePath)
      if (original.exists) {
        throw new PathJailError('The original path is occupied. Undo refused.')
      }
      this.renameSilent(toPath, record.relativePath)
    } else {
      throw new PathJailError(`Unsupported change type ${record.changeType}.`)
    }
    this.database.markFileChangesReviewStatus([id], 'undone')
  }

  private assertCurrentHash(root: string, relativePath: string, expected: string | null): void {
    if (!expected) {
      throw new PathJailError('Applied content hash is missing. Undo refused.')
    }
    const current = this.hashIfFile(root, relativePath)
    if (current !== expected) {
      throw new PathJailError('The file changed after KERN applied this modification. Undo refused.')
    }
  }

  private writeSilent(relativePath: string, content: string): void {
    const root = this.requireRoot()
    const entry = resolveEntry(root, relativePath)
    const target = entry.exists ? resolveInside(root, relativePath) : entry.lexical
    writeFileAtomic(target, content)
  }

  private removeSilent(relativePath: string): void {
    const root = this.requireRoot()
    const entry = resolveEntry(root, relativePath)
    if (!entry.exists) {
      return
    }
    if (entry.isSymbolicLink) {
      fs.unlinkSync(entry.lexical)
      return
    }
    const stat = fs.lstatSync(entry.lexical)
    if (stat.isDirectory()) {
      throw new PathJailError('Directory undo is not supported.')
    }
    fs.unlinkSync(entry.lexical)
  }

  private renameSilent(from: string, to: string): void {
    const root = this.requireRoot()
    const source = resolveEntry(root, from)
    const destination = resolveEntry(root, to)
    if (!source.exists) {
      throw new PathJailError('Renamed file is missing. Undo refused.')
    }
    if (destination.exists) {
      throw new PathJailError('The original path is occupied. Undo refused.')
    }
    fs.renameSync(source.lexical, destination.lexical)
  }

  private hashIfFile(root: string, relativePath: string): string | null {
    const text = this.previousText(root, relativePath)
    return text === null ? null : contentHash(text)
  }

  private requireRoot(): string {
    if (!this.root) {
      throw new PathJailError('No workspace is open')
    }
    return this.root
  }

  private previousText(root: string, relativePath: string): string | null {
    try {
      const target = resolveInside(root, relativePath)
      const stat = fs.statSync(target)
      if (!stat.isFile() || stat.size > MAX_REVERSE_BYTES) {
        return null
      }
      const bytes = fs.readFileSync(target)
      if (bytes.includes(0)) {
        return null
      }
      return bytes.toString('utf8')
    } catch {
      return null
    }
  }
}
