import { z } from 'zod'

export const workspaceChangeKinds = ['add', 'unlink', 'change', 'rename', 'refresh'] as const
export type WorkspaceChangeKind = (typeof workspaceChangeKinds)[number]

export const workspaceChangeEntrySchema = z.strictObject({
  path: z.string().min(1).max(4096),
  kind: z.enum(workspaceChangeKinds),
  isDirectory: z.boolean().optional()
})

export const workspaceChangedEventSchema = z.strictObject({
  type: z.literal('workspace.changed'),
  root: z.string().min(1),
  changes: z.array(workspaceChangeEntrySchema).max(500),
  truncated: z.boolean(),
  reason: z.enum(['watcher', 'mutation', 'command', 'manual']).optional()
})

export type WorkspaceChangeEntry = z.infer<typeof workspaceChangeEntrySchema>
export type WorkspaceChangedEvent = z.infer<typeof workspaceChangedEventSchema>

export const WATCH_IGNORE_NAMES = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  '.pnpm-store',
  'coverage',
  '.next',
  '.expo',
  '.turbo',
  '.cache',
  'DerivedData'
])

export function shouldIgnoreWatchPath(relativePath: string): boolean {
  const parts = relativePath.replaceAll('\\', '/').split('/').filter(Boolean)
  if (parts.length === 0) return false
  // Allow .git/HEAD and .git/index for git refresh; ignore the rest of .git.
  if (parts[0] === '.git') {
    return !(parts.length === 2 && (parts[1] === 'HEAD' || parts[1] === 'index'))
  }
  return parts.some((part) => WATCH_IGNORE_NAMES.has(part))
}

export function parentDirectory(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/').replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '.' : normalized.slice(0, index)
}

/** Coalesce raw FS events into bounded directory-oriented batches. */
export function coalesceWatchEvents(
  events: Array<{ path: string; kind: WorkspaceChangeKind; isDirectory?: boolean }>,
  options?: { maxEntries?: number; burstThreshold?: number }
): { changes: WorkspaceChangeEntry[]; truncated: boolean } {
  const maxEntries = options?.maxEntries ?? 200
  const burstThreshold = options?.burstThreshold ?? 2_000
  if (events.length >= burstThreshold) {
    const tops = new Set<string>()
    for (const event of events) {
      const top = event.path.replaceAll('\\', '/').split('/').filter(Boolean)[0]
      tops.add(top ? top : '.')
    }
    return {
      changes: [...tops].slice(0, 40).map((path) => ({ path, kind: 'refresh' as const, isDirectory: true })),
      truncated: true
    }
  }
  const byDir = new Map<string, WorkspaceChangeEntry>()
  for (const event of events) {
    if (shouldIgnoreWatchPath(event.path)) continue
    const dir = parentDirectory(event.path)
    const key = `${dir}\0${event.kind}`
    if (!byDir.has(key)) {
      byDir.set(key, { path: dir, kind: event.kind === 'change' ? 'change' : event.kind, isDirectory: true })
    }
    // Also keep the leaf when small.
    if (byDir.size < maxEntries) {
      byDir.set(event.path, { path: event.path, kind: event.kind, isDirectory: event.isDirectory })
    }
  }
  const changes = [...byDir.values()].slice(0, maxEntries)
  return { changes, truncated: byDir.size > maxEntries || events.length > maxEntries }
}
