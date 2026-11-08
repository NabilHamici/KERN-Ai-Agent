import type { MissionStatus } from '../../../shared/agent.ts'

export type AgentUiStatus =
  | { kind: 'idle'; label: string }
  | { kind: 'thinking'; label: string; startedAt: number }
  | { kind: 'tool_running'; label: string; toolName: string; target: string; startedAt: number }
  | { kind: 'awaiting_approval'; label: string; detail: string }
  | { kind: 'stopping'; label: string }
  | { kind: 'finished'; label: string; missionStatus: MissionStatus }

export type StatusInput = {
  running: boolean
  missionStatus: MissionStatus | null
  toolName?: string | null
  toolState?: string | null
  toolArgumentsText?: string | null
  pendingDeletionCount?: number
  cancelling?: boolean
  now?: number
  /** Stable timer origin while the same live phase continues. */
  startedAt?: number
}

const THINKING: MissionStatus[] = ['queued', 'analyzing', 'planning']

export function deriveAgentUiStatus(input: StatusInput): AgentUiStatus {
  const now = input.now ?? Date.now()
  const startedAt = input.startedAt ?? now
  if (input.cancelling) {
    return { kind: 'stopping', label: 'Stopping…' }
  }
  if (!input.running || !input.missionStatus) {
    return { kind: 'idle', label: 'Ready' }
  }
  if (input.missionStatus === 'awaiting_approval') {
    const count = input.pendingDeletionCount ?? 0
    return {
      kind: 'awaiting_approval',
      label: 'Needs your approval',
      detail: count > 0 ? `delete ${count} path${count === 1 ? '' : 's'}` : 'pending file change'
    }
  }
  if (
    input.missionStatus === 'executing' &&
    input.toolState &&
    (input.toolState === 'started' || input.toolState === 'running') &&
    input.toolName
  ) {
    return {
      kind: 'tool_running',
      label: humanToolVerb(input.toolName),
      toolName: input.toolName,
      target: toolTarget(input.toolName, input.toolArgumentsText ?? ''),
      startedAt
    }
  }
  if (THINKING.includes(input.missionStatus) || input.missionStatus === 'executing' || input.missionStatus === 'verifying') {
    return {
      kind: 'thinking',
      label: input.missionStatus === 'verifying' ? 'Checking results…' : 'Waiting for model…',
      startedAt
    }
  }
  // Terminal mission while UI still thinks it is "running" — treat as finished, then idle once running clears.
  return {
    kind: 'finished',
    label: input.missionStatus.replaceAll('_', ' '),
    missionStatus: input.missionStatus
  }
}

export function statusPhaseKey(status: AgentUiStatus): string {
  if (status.kind === 'tool_running') {
    return `tool:${status.toolName}:${status.target}`
  }
  if (status.kind === 'awaiting_approval') {
    return `approval:${status.detail}`
  }
  return status.kind
}

export function humanToolVerb(name: string): string {
  switch (name) {
    case 'run_command':
      return 'Running command'
    case 'read_file':
      return 'Reading'
    case 'list_files':
      return 'Listing'
    case 'search_files':
      return 'Searching'
    case 'create_file':
      return 'Creating'
    case 'edit_file':
      return 'Editing'
    case 'delete_file':
      return 'Deleting'
    case 'rename_file':
      return 'Renaming'
    case 'restore_file':
      return 'Restoring'
    default:
      return name.replaceAll('_', ' ')
  }
}

export function toolTarget(name: string, argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>
    if (name === 'run_command') {
      const command = typeof parsed.command === 'string' ? parsed.command : 'command'
      const args = Array.isArray(parsed.args) ? parsed.args.filter((item) => typeof item === 'string') : []
      return [command, ...args].join(' ')
    }
    if (typeof parsed.path === 'string' && parsed.path.trim()) {
      return parsed.path
    }
    if (Array.isArray(parsed.paths) && parsed.paths.length > 0) {
      return `${parsed.paths.length} paths`
    }
    if (typeof parsed.query === 'string') {
      return parsed.query
    }
    if (typeof parsed.pattern === 'string') {
      return parsed.pattern
    }
  } catch {
    // Fall through.
  }
  return ''
}

export function formatElapsed(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}
