import { z } from 'zod'

const invalid = { error: 'Invalid request' } as const

export const MISSION_STATUSES = [
  'queued',
  'analyzing',
  'planning',
  'awaiting_approval',
  'executing',
  'verifying',
  'completed',
  'partially_completed',
  'blocked',
  'failed',
  'cancelled',
  'interrupted'
] as const

export type MissionStatus = (typeof MISSION_STATUSES)[number]

export const TERMINAL_MISSION_STATUSES = [
  'completed',
  'partially_completed',
  'blocked',
  'failed',
  'cancelled',
  'interrupted'
] as const

export const TOOL_EXECUTION_STATES = [
  'success',
  'rejected',
  'awaiting_approval',
  'failed',
  'cancelled',
  'running',
  // Persisted legacy aliases from earlier builds.
  'started',
  'finished'
] as const

export type ToolExecutionState = (typeof TOOL_EXECUTION_STATES)[number]

const TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  queued: ['analyzing', 'cancelled', 'interrupted'],
  analyzing: [
    'planning',
    'executing',
    'awaiting_approval',
    'verifying',
    'completed',
    'partially_completed',
    'blocked',
    'failed',
    'cancelled',
    'interrupted'
  ],
  planning: ['analyzing', 'executing', 'awaiting_approval', 'cancelled', 'interrupted'],
  awaiting_approval: ['executing', 'analyzing', 'verifying', 'blocked', 'failed', 'cancelled', 'interrupted'],
  executing: ['analyzing', 'awaiting_approval', 'verifying', 'blocked', 'failed', 'cancelled', 'interrupted'],
  verifying: ['analyzing', 'completed', 'partially_completed', 'blocked', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  partially_completed: [],
  blocked: [],
  failed: [],
  cancelled: [],
  interrupted: []
}

export const AGENT_LIMITS = {
  maxIterations: 14,
  maxToolCalls: 40,
  maxProductiveToolCalls: 24,
  maxReadOnlyToolCalls: 24,
  maxIdenticalToolRepeats: 1,
  maxEmptyModelTurns: 2,
  maxNovelFailures: 8,
  maxConsecutiveReadOnlyWithoutAction: 6,
  maxExplorationGraceIterations: 2,
  maxConsecutiveArgumentErrors: 4,
  requestTimeoutMs: 45_000,
  maxToolOutputChars: 12_000,
  maxContextChars: 80_000,
  maxOutputTokens: 4_096,
  defaultCommandTimeoutMs: 120_000,
  maxCommandTimeoutMs: 300_000,
  maxCommandOutputChars: 12_000,
  maxListEntries: 200,
  maxRecursiveListEntries: 2_000,
  maxListDepth: 6,
  maxSearchResults: 40,
  maxDeletePaths: 40,
  maxDeleteBackupBytes: 5_000_000,
  maxStoredTextChars: 32_000,
  maxProposalChars: 200_000,
  serviceRetries: 2
} as const

/** Directory names that must never be deleted unless the user names them explicitly. */
export const PROTECTED_DELETE_NAMES = ['.git', '.kern'] as const

/** Dependency/build dirs listed as one regenerable entry, never file-enumerated for delete backups. */
export const REGENERABLE_DELETE_NAMES = [
  'node_modules',
  'out',
  'dist',
  'build',
  '.pnpm-store',
  'coverage'
] as const

export const MUTATION_TOOLS = ['create_file', 'edit_file', 'delete_file', 'rename_file', 'restore_file'] as const

export type MutationToolName = (typeof MUTATION_TOOLS)[number]

/** Only destructive deletion waits for an explicit user decision. */
export const APPROVAL_REQUIRED_MUTATION_TOOLS = ['delete_file'] as const

export function isMutationTool(name: string): name is MutationToolName {
  return (MUTATION_TOOLS as readonly string[]).includes(name)
}

export function mutationRequiresApproval(name: string): boolean {
  return (APPROVAL_REQUIRED_MUTATION_TOOLS as readonly string[]).includes(name)
}

export const OPERATION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'applied',
  'failed',
  'cancelled',
  'stale'
] as const

export type OperationStatus = (typeof OPERATION_STATUSES)[number]

export const OPERATION_KINDS = ['create', 'edit', 'delete', 'rename', 'restore'] as const

export type OperationKind = (typeof OPERATION_KINDS)[number]

export function operationRequiresApproval(kind: OperationKind): boolean {
  return kind === 'delete'
}

export type AgentOperationSummary = {
  id: string
  missionId: string
  callId: string
  kind: OperationKind
  path: string
  toPath: string | null
  explanation: string
  status: OperationStatus
  unifiedDiff: string
  destructive: boolean
  error: string | null
  contentFingerprint: string
  sourceOperationId: string | null
  createdAt: string
  resolvedAt: string | null
}

export function isMissionStatus(value: string): value is MissionStatus {
  return (MISSION_STATUSES as readonly string[]).includes(value)
}

export function isTerminalStatus(status: MissionStatus): boolean {
  return (TERMINAL_MISSION_STATUSES as readonly string[]).includes(status)
}

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentError'
  }
}

export function assertTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransition(from, to)) {
    throw new AgentError('Invalid mission transition')
  }
}

export function redactSensitive(text: string, secret?: string | null): string {
  let output = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  if (secret && secret.length >= 8) {
    output = output.split(secret).join('[redacted]')
  }
  return output
}

export function missionTitle(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0] ?? 'Mission'
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

export const agentEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('status'),
    missionId: z.string().min(1).max(80),
    status: z.enum(MISSION_STATUSES),
    title: z.string().max(120)
  }),
  z.strictObject({
    type: z.literal('text'),
    missionId: z.string().min(1).max(80),
    delta: z.string().max(8_000)
  }),
  z.strictObject({
    type: z.literal('tool'),
    missionId: z.string().min(1).max(80),
    callId: z.string().min(1).max(200),
    name: z.string().min(1).max(80),
    argumentsText: z.string().max(2_000),
    state: z.enum(TOOL_EXECUTION_STATES),
    output: z.string().max(16_000).optional()
  }),
  z.strictObject({
    type: z.literal('error'),
    missionId: z.string().min(1).max(80),
    message: z.string().max(2_000)
  }),
  z.strictObject({
    type: z.literal('finished'),
    missionId: z.string().min(1).max(80),
    status: z.enum(MISSION_STATUSES),
    summary: z.string().max(4_000),
    usage: z
      .strictObject({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative()
      })
      .optional()
  }),
  z.strictObject({
    type: z.literal('proposal'),
    missionId: z.string().min(1).max(80),
    operation: z.strictObject({
      id: z.string().min(36).max(36),
      kind: z.enum(OPERATION_KINDS),
      path: z.string().min(1).max(4096),
      toPath: z.string().min(1).max(4096).nullable(),
      explanation: z.string().max(500),
      status: z.enum(OPERATION_STATUSES),
      unifiedDiff: z.string().max(16_000),
      destructive: z.boolean(),
      error: z.string().max(2_000).nullable(),
      contentFingerprint: z.string().min(1).max(128)
    })
  })
])

export type AgentEvent = z.infer<typeof agentEventSchema>

const missionIdSchema = z
  .string()
  .min(36)
  .max(36)
  .refine((value) => /^[0-9a-f-]{36}$/i.test(value), invalid)

const operationIdSchema = z
  .string()
  .min(36)
  .max(36)
  .refine((value) => /^[0-9a-f-]{36}$/i.test(value), invalid)

export const agentSubmitSchema = z.strictObject({
  prompt: z.string().min(1).max(8_000),
  chatId: missionIdSchema.optional(),
  continueFromMissionId: missionIdSchema.optional()
})

export const chatIdSchema = missionIdSchema

export const chatCreateSchema = z.strictObject({})

export const chatListSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional()
})

export const chatGetSchema = z.strictObject({
  chatId: chatIdSchema
})

export const chatRenameSchema = z.strictObject({
  chatId: chatIdSchema,
  title: z.string().min(1).max(120)
})

export const chatArchiveSchema = z.strictObject({
  chatId: chatIdSchema
})

export const agentCancelSchema = z.strictObject({
  missionId: missionIdSchema
})

export const agentApproveSchema = z.strictObject({
  missionId: missionIdSchema,
  operationId: operationIdSchema
})

export const agentRejectSchema = z.strictObject({
  missionId: missionIdSchema,
  operationId: operationIdSchema
})

export const agentRestoreSchema = z.strictObject({
  operationId: operationIdSchema
})

export type AgentMissionSummary = {
  id: string
  chatId: string | null
  title: string
  prompt: string
  status: MissionStatus
  iteration: number
  toolCalls: number
  summary: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export type AgentChatSummary = {
  id: string
  workspacePath: string
  title: string
  titleLocked: boolean
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  latestMissionStatus: MissionStatus | null
}

export type AgentChatTranscript = {
  chat: AgentChatSummary
  missions: AgentMissionSummary[]
  turns: AgentTranscript[]
}

/** Deterministic local title from the first user request. */
export function chatTitleFromPrompt(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0] ?? 'New chat'
  const cleaned = line.replace(/\s+/g, ' ').trim()
  if (!cleaned) {
    return 'New chat'
  }
  return cleaned.length > 48 ? `${cleaned.slice(0, 47)}…` : cleaned
}

export type AgentToolRecord = {
  callId: string
  name: string
  argumentsText: string
  state: ToolExecutionState
  output: string
  createdAt?: string
}

export function normalizeToolExecutionState(state: string): ToolExecutionState {
  if (state === 'started') {
    return 'awaiting_approval'
  }
  if (state === 'finished') {
    return 'success'
  }
  if ((TOOL_EXECUTION_STATES as readonly string[]).includes(state)) {
    return state as ToolExecutionState
  }
  return 'failed'
}

export function isActiveToolExecution(state: ToolExecutionState | string): boolean {
  const normalized = normalizeToolExecutionState(state)
  return normalized === 'awaiting_approval' || normalized === 'running'
}

export function isSuccessfulToolExecution(state: ToolExecutionState | string): boolean {
  return normalizeToolExecutionState(state) === 'success'
}

export type AgentTranscript = {
  mission: AgentMissionSummary
  messages: Array<{ role: string; content: string; createdAt?: string }>
  tools: AgentToolRecord[]
  operations: AgentOperationSummary[]
}
