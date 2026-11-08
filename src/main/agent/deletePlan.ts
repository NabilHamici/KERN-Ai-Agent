import fs from 'node:fs'
import path from 'node:path'
import {
  AGENT_LIMITS,
  PROTECTED_DELETE_NAMES,
  REGENERABLE_DELETE_NAMES
} from '../../shared/agent.ts'
import { PathJailError, normalizeRelative, resolveEntry, resolveInside } from '../security/pathJail.ts'

export type DeletePlanTarget = {
  path: string
  kind: 'file' | 'directory' | 'symlink'
  regenerable?: boolean
  bytes: number
}

export type DeletePlanExcluded = {
  path: string
  reason: string
}

export type DeleteSnapshotEntry = {
  path: string
  type: 'file' | 'symlink' | 'directory'
  content?: string | null
  linkTarget?: string
  omitted?: boolean
}

export type DeleteSnapshot = {
  kind: 'tree'
  version: 1
  entries: DeleteSnapshotEntry[]
  complete: boolean
  omittedFiles: number
  omittedBytes: number
}

export type DeletePlan = {
  targets: DeletePlanTarget[]
  excluded: DeletePlanExcluded[]
  fileCount: number
  dirCount: number
  totalBytes: number
  snapshot: DeleteSnapshot
  snapshotComplete: boolean
  displayPath: string
}

const PROTECTED = new Set<string>(PROTECTED_DELETE_NAMES)
const REGENERABLE = new Set<string>(REGENERABLE_DELETE_NAMES)

export function isTreeSnapshot(text: string | null): text is string {
  if (!text) {
    return false
  }
  try {
    const parsed = JSON.parse(text) as { kind?: string }
    return parsed.kind === 'tree'
  } catch {
    return false
  }
}

export function parseDeleteSnapshot(text: string): DeleteSnapshot {
  return JSON.parse(text) as DeleteSnapshot
}

export function buildDeletePlan(input: {
  root: string
  path?: string
  paths?: string[]
  recursive: boolean
  /** Protected names the user explicitly confirmed for deletion (e.g. [".git"]). */
  includeProtected?: string[]
}): DeletePlan {
  const requested = normalizeTargets(input.path, input.paths)
  if (requested.length === 0) {
    throw new PathJailError('Provide path or paths for delete_file.')
  }
  if (requested.length > AGENT_LIMITS.maxDeletePaths) {
    throw new PathJailError(`At most ${AGENT_LIMITS.maxDeletePaths} paths may be deleted in one proposal.`)
  }
  const includeProtected = new Set(
    (input.includeProtected ?? []).map((value) => value.trim()).filter(Boolean)
  )

  const targets: DeletePlanTarget[] = []
  const excluded: DeletePlanExcluded[] = []
  const snapshotEntries: DeleteSnapshotEntry[] = []
  let omittedFiles = 0
  let omittedBytes = 0
  let usedBytes = 0
  let complete = true
  let fileCount = 0
  let dirCount = 0
  let totalBytes = 0

  for (const raw of requested) {
    const relative = normalizeRelative(raw)
    if (relative === '.') {
      excluded.push({ path: '.', reason: 'Refusing to delete the workspace root.' })
      continue
    }
    const base = relative.split('/').pop() ?? relative
    if (PROTECTED.has(base) && !includeProtected.has(relative) && !includeProtected.has(base)) {
      excluded.push({
        path: relative,
        reason: 'Protected by default (.git / .kern). Pass include_protected with that name after the user confirms.'
      })
      continue
    }
    const entry = resolveEntry(input.root, relative)
    if (entry.lexical === entry.root) {
      excluded.push({ path: relative, reason: 'Refusing to delete the workspace root.' })
      continue
    }
    if (!entry.exists) {
      throw new PathJailError(`Path does not exist: ${relative}`)
    }
    if (entry.isSymbolicLink) {
      targets.push({ path: relative, kind: 'symlink', bytes: 0 })
      snapshotEntries.push({ path: relative, type: 'symlink', linkTarget: fs.readlinkSync(entry.lexical) })
      fileCount += 1
      continue
    }
    const stat = fs.lstatSync(entry.lexical)
    if (stat.isDirectory()) {
      if (!input.recursive) {
        throw new PathJailError(
          `Path is a directory. Pass recursive:true to delete ${relative}, or delete individual files.`
        )
      }
      if (REGENERABLE.has(base)) {
        targets.push({ path: relative, kind: 'directory', regenerable: true, bytes: 0 })
        snapshotEntries.push({ path: relative, type: 'directory', omitted: true })
        dirCount += 1
        continue
      }
      const walked = walkDirectoryForDelete(input.root, relative, usedBytes)
      usedBytes = walked.usedBytes
      complete = complete && walked.complete
      omittedFiles += walked.omittedFiles
      omittedBytes += walked.omittedBytes
      snapshotEntries.push(...walked.entries)
      targets.push({ path: relative, kind: 'directory', bytes: walked.totalBytes })
      fileCount += walked.fileCount
      dirCount += 1 + walked.dirCount
      totalBytes += walked.totalBytes
      continue
    }
    if (!stat.isFile()) {
      throw new PathJailError(`Unsupported path type: ${relative}`)
    }
    const bytes = stat.size
    totalBytes += bytes
    fileCount += 1
    targets.push({ path: relative, kind: 'file', bytes })
    if (usedBytes + bytes > AGENT_LIMITS.maxDeleteBackupBytes) {
      complete = false
      omittedFiles += 1
      omittedBytes += bytes
      snapshotEntries.push({ path: relative, type: 'file', content: null, omitted: true })
    } else {
      const content = readTextOrNull(entry.lexical)
      if (content === null) {
        complete = false
        omittedFiles += 1
        omittedBytes += bytes
        snapshotEntries.push({ path: relative, type: 'file', content: null, omitted: true })
      } else {
        usedBytes += Buffer.byteLength(content, 'utf8')
        snapshotEntries.push({ path: relative, type: 'file', content })
      }
    }
  }

  if (targets.length === 0) {
    throw new PathJailError(
      excluded.length > 0
        ? `Nothing to delete. Excluded: ${excluded.map((item) => `${item.path} (${item.reason})`).join('; ')}`
        : 'Nothing to delete.'
    )
  }

  const displayPath =
    targets.length === 1 ? targets[0]!.path : `(${targets.length} paths)`
  return {
    targets,
    excluded,
    fileCount,
    dirCount,
    totalBytes,
    displayPath,
    snapshotComplete: complete,
    snapshot: {
      kind: 'tree',
      version: 1,
      entries: snapshotEntries,
      complete,
      omittedFiles,
      omittedBytes
    }
  }
}

export function formatDeleteDiff(plan: DeletePlan): string {
  const lines = [
    `Delete proposal: ${plan.targets.length} target(s)`,
    `Files: ${plan.fileCount}  Directories: ${plan.dirCount}  Bytes: ${plan.totalBytes}`,
    `Snapshot complete: ${plan.snapshotComplete ? 'yes' : 'NO — restore will be partial'}`,
    'Targets:'
  ]
  for (const target of plan.targets) {
    const flags = [
      target.kind,
      target.regenerable ? 'regenerable' : null
    ].filter(Boolean)
    lines.push(`- ${target.path} (${flags.join(', ')})`)
  }
  if (plan.excluded.length > 0) {
    lines.push('Excluded (not deleted):')
    for (const item of plan.excluded) {
      lines.push(`- ${item.path}: ${item.reason}`)
    }
  }
  return lines.join('\n')
}

function normalizeTargets(pathValue?: string, paths?: string[]): string[] {
  const values: string[] = []
  if (Array.isArray(paths)) {
    for (const item of paths) {
      if (typeof item === 'string' && item.trim()) {
        values.push(item.trim())
      }
    }
  }
  if (typeof pathValue === 'string' && pathValue.trim()) {
    values.push(pathValue.trim())
  }
  return [...new Set(values)]
}

function walkDirectoryForDelete(
  root: string,
  relative: string,
  startingBytes: number
): {
  entries: DeleteSnapshotEntry[]
  fileCount: number
  dirCount: number
  totalBytes: number
  usedBytes: number
  complete: boolean
  omittedFiles: number
  omittedBytes: number
} {
  const entries: DeleteSnapshotEntry[] = [{ path: relative, type: 'directory' }]
  let fileCount = 0
  let dirCount = 0
  let totalBytes = 0
  let usedBytes = startingBytes
  let complete = true
  let omittedFiles = 0
  let omittedBytes = 0
  const queue = [relative]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)
    let names: string[]
    try {
      names = fs.readdirSync(resolveInside(root, current))
    } catch {
      continue
    }
    for (const name of names) {
      const child = `${current}/${name}`
      const base = name
      if (PROTECTED.has(base)) {
        continue
      }
      const entry = resolveEntry(root, child)
      if (!entry.exists) continue
      if (entry.isSymbolicLink) {
        entries.push({ path: child, type: 'symlink', linkTarget: fs.readlinkSync(entry.lexical) })
        fileCount += 1
        continue
      }
      const stat = fs.lstatSync(entry.lexical)
      if (stat.isDirectory()) {
        if (REGENERABLE.has(base)) {
          entries.push({ path: child, type: 'directory', omitted: true })
          dirCount += 1
          continue
        }
        entries.push({ path: child, type: 'directory' })
        dirCount += 1
        queue.push(child)
        continue
      }
      if (!stat.isFile()) continue
      fileCount += 1
      totalBytes += stat.size
      if (usedBytes + stat.size > AGENT_LIMITS.maxDeleteBackupBytes) {
        complete = false
        omittedFiles += 1
        omittedBytes += stat.size
        entries.push({ path: child, type: 'file', content: null, omitted: true })
        continue
      }
      const content = readTextOrNull(entry.lexical)
      if (content === null) {
        complete = false
        omittedFiles += 1
        omittedBytes += stat.size
        entries.push({ path: child, type: 'file', content: null, omitted: true })
      } else {
        usedBytes += Buffer.byteLength(content, 'utf8')
        entries.push({ path: child, type: 'file', content })
      }
    }
  }
  return { entries, fileCount, dirCount, totalBytes, usedBytes, complete, omittedFiles, omittedBytes }
}

function readTextOrNull(absolute: string): string | null {
  try {
    const stat = fs.statSync(absolute)
    if (!stat.isFile() || stat.size > 2_000_000) {
      return null
    }
    const bytes = fs.readFileSync(absolute)
    if (bytes.includes(0)) {
      return null
    }
    return bytes.toString('utf8')
  } catch {
    return null
  }
}

export function restoreTreeSnapshot(input: {
  root: string
  snapshot: DeleteSnapshot
  createFile: (relativePath: string, content: string) => void
  ensureDir: (relativePath: string) => void
}): { restored: number; skipped: number } {
  let restored = 0
  let skipped = 0
  const dirs = input.snapshot.entries
    .filter((entry) => entry.type === 'directory')
    .map((entry) => entry.path)
    .sort((a, b) => a.split('/').length - b.split('/').length)
  for (const dir of dirs) {
    input.ensureDir(dir)
  }
  for (const entry of input.snapshot.entries) {
    if (entry.type === 'directory') {
      continue
    }
    if (entry.type === 'symlink' && entry.linkTarget) {
      const target = resolveInside(input.root, entry.path)
      const parent = path.dirname(target)
      fs.mkdirSync(parent, { recursive: true })
      if (!fs.existsSync(target)) {
        fs.symlinkSync(entry.linkTarget, target)
        restored += 1
      } else {
        skipped += 1
      }
      continue
    }
    if (entry.omitted || entry.content == null) {
      skipped += 1
      continue
    }
    input.createFile(entry.path, entry.content)
    restored += 1
  }
  return { restored, skipped }
}
