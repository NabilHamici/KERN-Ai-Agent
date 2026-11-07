import type { MissionStatus } from '../../shared/agent'

/** Phases the sidebar can show. A phase is rendered only when an event maps to it. */
export const AGENT_ACTIVITY_PHASES = [
  'idle',
  'queued',
  'thinking',
  'planning',
  'scanning',
  'reading',
  'executing',
  'awaiting_approval',
  'verifying',
  'refactoring',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
] as const

export type AgentActivityPhase = (typeof AGENT_ACTIVITY_PHASES)[number]

export type AgentActivity = {
  phase: AgentActivityPhase
  label: string
  /** Stays null until a mission reports real progress. The bar is not a percentage. */
  progress: null
}

const SCAN_TOOLS = new Set(['list_files', 'search_files'])
const READ_TOOLS = new Set(['read_file'])

/**
 * Write and edit tools belong here once the broker can run them.
 * The set is empty, so Refactoring is never shown from the current tools.
 */
export const REFACTOR_TOOLS = new Set<string>()

const LABELS: Record<AgentActivityPhase, string> = {
  idle: 'Idle',
  queued: 'Queued',
  thinking: 'Thinking',
  planning: 'Planning',
  scanning: 'Scanning',
  reading: 'Reading',
  executing: 'Executing',
  awaiting_approval: 'Awaiting approval',
  verifying: 'Verifying',
  refactoring: 'Refactoring',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted'
}

export function agentActivity(input: {
  running: boolean
  status: MissionStatus | null
  toolName?: string | null
  toolState?: 'started' | 'finished' | 'rejected' | null
}): AgentActivity {
  const status = input.status
  if (!input.running) {
    if (!status) {
      return activity('idle')
    }
    if (status === 'analyzing') {
      return activity('thinking')
    }
    return activity(phaseForStatus(status))
  }

  if (status === 'planning' || status === 'awaiting_approval' || status === 'verifying' || status === 'queued') {
    return activity(status)
  }

  if (status === 'executing' && input.toolState === 'started' && input.toolName) {
    if (SCAN_TOOLS.has(input.toolName)) {
      return activity('scanning')
    }
    if (READ_TOOLS.has(input.toolName)) {
      return activity('reading')
    }
    if (REFACTOR_TOOLS.has(input.toolName)) {
      return activity('refactoring')
    }
    return activity('executing')
  }

  if (status === 'analyzing' || status === 'executing') {
    return activity('thinking')
  }

  if (status) {
    return activity(phaseForStatus(status))
  }
  return activity('thinking')
}

function activity(phase: AgentActivityPhase): AgentActivity {
  return { phase, label: LABELS[phase], progress: null }
}

function phaseForStatus(status: MissionStatus): AgentActivityPhase {
  return (AGENT_ACTIVITY_PHASES as readonly string[]).includes(status) ? (status as AgentActivityPhase) : 'idle'
}
