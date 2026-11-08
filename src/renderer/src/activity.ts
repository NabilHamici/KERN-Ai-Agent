import {
  isActiveToolExecution,
  isSuccessfulToolExecution,
  normalizeToolExecutionState,
  type AgentToolRecord,
  type MissionStatus,
  type ToolExecutionState
} from '../../shared/agent.ts'

/** Phases the sidebar can show. A phase is rendered only when an event maps to it. */
export const AGENT_ACTIVITY_PHASES = [
  'idle',
  'queued',
  'thinking',
  'planning',
  'inspecting',
  'searching',
  'reading',
  'executing',
  'editing',
  'awaiting_approval',
  'verifying',
  'completed',
  'partially_completed',
  'blocked',
  'failed',
  'cancelled',
  'interrupted'
] as const

export type AgentActivityPhase = (typeof AGENT_ACTIVITY_PHASES)[number]

export type AgentActivity = {
  phase: AgentActivityPhase
  label: string
  detail: string
  /** Stays null until a mission reports real progress. The bar is not a percentage. */
  progress: null
}

const INSPECT_TOOLS = new Set(['list_files', 'get_workspace_info', 'list_file_operations'])
const SEARCH_TOOLS = new Set(['search_files'])
const READ_TOOLS = new Set(['read_file'])

export const REFACTOR_TOOLS = new Set(['create_file', 'edit_file', 'delete_file', 'rename_file', 'restore_file'])

const LABELS: Record<AgentActivityPhase, string> = {
  idle: 'Idle',
  queued: 'Queued',
  thinking: 'Thinking',
  planning: 'Planning',
  inspecting: 'Inspecting',
  searching: 'Searching',
  reading: 'Inspecting',
  executing: 'Executing',
  editing: 'Editing',
  awaiting_approval: 'Waiting for approval',
  verifying: 'Verifying',
  completed: 'Completed',
  partially_completed: 'Partially completed',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Interrupted',
  interrupted: 'Interrupted'
}

const DETAILS: Record<AgentActivityPhase, string> = {
  idle: 'Awaiting next user instruction',
  queued: 'Mission queued…',
  thinking: 'Understanding your request…',
  planning: 'Preparing next actions…',
  inspecting: 'Reading project structure and source…',
  searching: 'Searching for relevant code…',
  reading: 'Reading source files…',
  executing: 'Running an authorized tool…',
  editing: 'Preparing a code change…',
  awaiting_approval: 'A user decision is required…',
  verifying: 'Checking results…',
  completed: 'Task finished successfully',
  partially_completed: 'Some work applied; remaining deliverables incomplete',
  blocked: 'Execution stopped on a blocker',
  failed: 'Execution stopped with an error',
  cancelled: 'Execution was cancelled',
  interrupted: 'Execution was interrupted'
}

export function agentActivity(input: {
  running: boolean
  status: MissionStatus | null
  toolName?: string | null
  toolState?: ToolExecutionState | null
  notice?: string | null
}): AgentActivity {
  const status = input.status
  if (!input.running) {
    if (!status) {
      return activity('idle')
    }
    if (status === 'analyzing') {
      return activity('thinking', input.notice)
    }
    return activity(phaseForStatus(status), input.notice)
  }

  if (status === 'planning') {
    return activity('planning', input.notice)
  }
  if (status === 'awaiting_approval') {
    return activity('awaiting_approval', input.notice)
  }
  if (status === 'verifying') {
    return activity('verifying', input.notice)
  }
  if (status === 'queued') {
    return activity('queued', input.notice)
  }

  if (status === 'executing' && input.toolState && isActiveToolExecution(input.toolState) && input.toolName) {
    if (SEARCH_TOOLS.has(input.toolName)) {
      return activity('searching', input.notice)
    }
    if (INSPECT_TOOLS.has(input.toolName)) {
      return activity('inspecting', input.notice)
    }
    if (READ_TOOLS.has(input.toolName)) {
      return activity('reading', input.notice)
    }
    if (REFACTOR_TOOLS.has(input.toolName)) {
      return activity('editing', input.notice)
    }
    if (input.toolName === 'run_command') {
      return activity('executing', input.notice || 'Running a workspace command…')
    }
    return activity('executing', input.notice)
  }

  if (status === 'analyzing' || status === 'executing') {
    return activity('thinking', input.notice)
  }

  if (status) {
    return activity(phaseForStatus(status), input.notice)
  }
  return activity('thinking', input.notice)
}

/** Compact completed steps for the live panel — phase summaries, not a second tool list. */
export function completedActivitySteps(tools: AgentToolRecord[], limit = 4): string[] {
  const steps: string[] = []
  for (const tool of tools) {
    if (tool.name === 'submit_result' || isActiveToolExecution(tool.state)) {
      continue
    }
    const label = completedStepLabel(tool)
    if (label && !steps.includes(label)) {
      steps.push(label)
    }
  }
  return steps.slice(-limit)
}

function completedStepLabel(tool: AgentToolRecord): string {
  const state = normalizeToolExecutionState(tool.state)
  if (state === 'rejected' || state === 'failed' || state === 'cancelled') {
    return `${tool.name} ${state}`
  }
  if (SEARCH_TOOLS.has(tool.name)) {
    return 'Search completed'
  }
  if (tool.name === 'list_files' || tool.name === 'get_workspace_info') {
    return 'Project structure inspected'
  }
  if (tool.name === 'list_file_operations') {
    return 'Operation history inspected'
  }
  if (READ_TOOLS.has(tool.name)) {
    return 'Source files inspected'
  }
  if (REFACTOR_TOOLS.has(tool.name)) {
    return isSuccessfulToolExecution(state) ? 'Change prepared' : `${tool.name} ${state}`
  }
  if (tool.name === 'run_command') {
    return isSuccessfulToolExecution(state) ? 'Command completed' : `Command ${state}`
  }
  return `${tool.name} completed`
}

function activity(phase: AgentActivityPhase, notice?: string | null): AgentActivity {
  return {
    phase,
    label: LABELS[phase],
    detail: notice?.trim() || DETAILS[phase],
    progress: null
  }
}

function phaseForStatus(status: MissionStatus): AgentActivityPhase {
  if (status === 'analyzing') {
    return 'thinking'
  }
  if (status === 'cancelled') {
    return 'cancelled'
  }
  return (AGENT_ACTIVITY_PHASES as readonly string[]).includes(status) ? (status as AgentActivityPhase) : 'idle'
}
