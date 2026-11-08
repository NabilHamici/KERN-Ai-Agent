import fs from 'node:fs'
import path from 'node:path'
import {
  coalesceWatchEvents,
  shouldIgnoreWatchPath,
  type WorkspaceChangeKind,
  type WorkspaceChangedEvent
} from '../../shared/workspaceEvents.ts'

type RawEvent = { path: string; kind: WorkspaceChangeKind; isDirectory?: boolean }

/**
 * Workspace file watcher using Node fs.watch (no extra dependency).
 * Batches bursts, ignores heavy trees, and supports self-trigger suppression.
 */
export class WorkspaceWatcher {
  private root: string | null = null
  private watcher: fs.FSWatcher | null = null
  private pending: RawEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private suppressUntil = 0
  private readonly emit: (event: WorkspaceChangedEvent) => void
  private readonly debounceMs: number

  constructor(emit: (event: WorkspaceChangedEvent) => void, debounceMs = 150) {
    this.emit = emit
    this.debounceMs = debounceMs
  }

  start(root: string): void {
    this.stop()
    this.root = path.resolve(root)
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (eventType, filename) => {
        if (!filename || !this.root) return
        if (Date.now() < this.suppressUntil) return
        const relative = filename.toString().replaceAll('\\', '/')
        if (shouldIgnoreWatchPath(relative)) return
        const absolute = path.join(this.root, relative)
        let isDirectory: boolean | undefined
        try {
          isDirectory = fs.statSync(absolute).isDirectory()
        } catch {
          isDirectory = undefined
        }
        const kind: WorkspaceChangeKind =
          eventType === 'rename' ? (isDirectory === undefined ? 'unlink' : 'add') : 'change'
        this.pending.push({ path: relative, kind, isDirectory })
        this.scheduleFlush('watcher')
      })
      this.watcher.on('error', () => {
        // Watcher errors are non-fatal; targeted refreshes still cover mutations/commands.
      })
    } catch {
      this.watcher = null
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = []
    this.watcher?.close()
    this.watcher = null
    this.root = null
  }

  /** Suppress echo from explorer/agent writes for a short window. */
  suppress(ms = 400): void {
    this.suppressUntil = Date.now() + ms
  }

  /** Belt-and-braces refresh after mutation/command (independent of OS watcher). */
  notifyRefresh(paths: string[], reason: 'mutation' | 'command' | 'manual' = 'manual'): void {
    if (!this.root) return
    for (const item of paths) {
      const relative = item.replaceAll('\\', '/').replace(/^\.\//, '') || '.'
      this.pending.push({ path: relative, kind: 'refresh', isDirectory: true })
    }
    this.scheduleFlush(reason)
  }

  private scheduleFlush(reason: WorkspaceChangedEvent['reason']): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush(reason)
    }, this.debounceMs)
  }

  private flush(reason: WorkspaceChangedEvent['reason']): void {
    if (!this.root || this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    const { changes, truncated } = coalesceWatchEvents(batch)
    if (changes.length === 0) return
    this.emit({
      type: 'workspace.changed',
      root: this.root,
      changes,
      truncated,
      reason
    })
  }
}
