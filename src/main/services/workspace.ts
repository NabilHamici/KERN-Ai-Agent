import fs from 'node:fs'
import path from 'node:path'
import { PathJailError, normalizeRelative, resolveEntry, resolveInside, workspaceRoot } from '../security/pathJail.ts'
import { writeFileAtomic } from './atomicWrite.ts'
import type { MissionDatabase } from './database.ts'
import type { DirectoryEntry, FileChangeRecord, MissionRecord, WorkspaceInfo } from '../../shared/ipc.ts'

const MAX_READ_BYTES = 2_000_000
const MAX_REVERSE_BYTES = 512_000
const WORKSPACE_SETTING = 'workspacePath'

export class WorkspaceService {
  private root: string | null = null
  private missionId: string | null = null
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
      return null
    }
  }

  open(folder: string): WorkspaceInfo {
    const root = workspaceRoot(folder)
    this.root = root
    this.database.setSetting(WORKSPACE_SETTING, root)
    const mission = this.database.createMission(root, path.basename(root))
    this.missionId = mission.id
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
      relativePath: normalizeRelative(relativePath),
      changeType: reverseText === null && !entry.exists ? 'create' : 'write',
      reverseText
    })
  }

  createFile(relativePath: string, content = ''): void {
    const root = this.requireRoot()
    const entry = resolveEntry(root, relativePath)
    if (entry.exists) {
      throw new PathJailError('Path already exists')
    }
    writeFileAtomic(entry.lexical, content)
    this.database.recordFileChange({
      missionId: this.missionId,
      relativePath: normalizeRelative(relativePath),
      changeType: 'create',
      reverseText: null
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
    fs.renameSync(source.lexical, destination.lexical)
    this.database.recordFileChange({
      missionId: this.missionId,
      relativePath: normalizeRelative(from),
      changeType: 'rename',
      reverseText: normalizeRelative(to)
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
      relativePath: normalizeRelative(relativePath),
      changeType: 'delete',
      reverseText
    })
  }

  listMissions(limit?: number): MissionRecord[] {
    return this.database.listMissions(limit)
  }

  listFileChanges(limit?: number): FileChangeRecord[] {
    return this.database.listFileChanges(limit)
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
