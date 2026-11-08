import fs from 'node:fs'
import { AGENT_LIMITS, PROTECTED_DELETE_NAMES, REGENERABLE_DELETE_NAMES } from '../../shared/agent.ts'
import { PathJailError, normalizeRelative, resolveInside } from '../security/pathJail.ts'

const SKIP_DESCEND = new Set<string>([...PROTECTED_DELETE_NAMES, ...REGENERABLE_DELETE_NAMES])

export type TreeListEntry = {
  path: string
  kind: 'file' | 'directory' | 'blocked'
  depth: number
  regenerable?: boolean
  protected?: boolean
  truncatedChildren?: number
}

export type TreeListResult = {
  path: string
  depth: number
  recursive: boolean
  entries: TreeListEntry[]
  truncated: boolean
  entryCount: number
  truncatedDirectories: Array<{ path: string; omitted: number }>
}

export function listWorkspaceTree(
  root: string,
  relativePath: string,
  options: { depth: number; recursive: boolean }
): TreeListResult {
  const relative = normalizeRelative(relativePath)
  const maxDepth = options.recursive ? AGENT_LIMITS.maxListDepth : Math.max(1, Math.min(options.depth, AGENT_LIMITS.maxListDepth))
  const maxEntries = options.recursive || maxDepth > 1 ? AGENT_LIMITS.maxRecursiveListEntries : AGENT_LIMITS.maxListEntries
  const directory = resolveInside(root, relative)
  if (!fs.statSync(directory).isDirectory()) {
    throw new PathJailError('Not a directory')
  }
  const entries: TreeListEntry[] = []
  const truncatedDirectories: Array<{ path: string; omitted: number }> = []
  let truncated = false
  const queue: Array<{ path: string; depth: number }> = [{ path: relative, depth: 0 }]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || seen.has(current.path)) {
      continue
    }
    seen.add(current.path)
    if (current.depth >= maxDepth) {
      continue
    }
    let names: string[]
    try {
      names = fs.readdirSync(resolveInside(root, current.path)).sort()
    } catch (error) {
      if (error instanceof PathJailError) {
        continue
      }
      throw error
    }
    let emittedHere = 0
    for (const name of names) {
      if (entries.length >= maxEntries) {
        truncated = true
        truncatedDirectories.push({ path: current.path, omitted: names.length - emittedHere })
        queue.length = 0
        break
      }
      if (name === '.env' || name.startsWith('.env.') || name.endsWith('.sqlite') || name === 'api-key.bin' || name === 'cursor-api-key.bin') {
        continue
      }
      const child = current.path === '.' ? name : `${current.path}/${name}`
      const base = name
      try {
        const resolved = resolveInside(root, child)
        const stat = fs.lstatSync(resolved)
        if (stat.isSymbolicLink()) {
          entries.push({ path: child, kind: 'file', depth: current.depth + 1 })
          emittedHere += 1
          continue
        }
        if (stat.isDirectory()) {
          const regenerable = (REGENERABLE_DELETE_NAMES as readonly string[]).includes(base)
          const protectedName = (PROTECTED_DELETE_NAMES as readonly string[]).includes(base)
          entries.push({
            path: child,
            kind: 'directory',
            depth: current.depth + 1,
            regenerable: regenerable || undefined,
            protected: protectedName || undefined
          })
          emittedHere += 1
          if (!SKIP_DESCEND.has(base) && current.depth + 1 < maxDepth) {
            queue.push({ path: child, depth: current.depth + 1 })
          }
          continue
        }
        entries.push({ path: child, kind: 'file', depth: current.depth + 1 })
        emittedHere += 1
      } catch {
        entries.push({ path: child, kind: 'blocked', depth: current.depth + 1 })
        emittedHere += 1
      }
    }
  }

  return {
    path: relative,
    depth: maxDepth,
    recursive: options.recursive || maxDepth > 1,
    entries,
    truncated,
    entryCount: entries.length,
    truncatedDirectories
  }
}
