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
  'failed',
  'cancelled',
  'interrupted'
] as const

export type MissionStatus = (typeof MISSION_STATUSES)[number]

export const TERMINAL_MISSION_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'] as const

const TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  queued: ['analyzing', 'cancelled', 'interrupted'],
  analyzing: ['planning', 'executing', 'verifying', 'completed', 'failed', 'cancelled', 'interrupted'],
  planning: ['analyzing', 'executing', 'cancelled', 'interrupted'],
  awaiting_approval: ['executing', 'failed', 'cancelled', 'interrupted'],
  executing: ['analyzing', 'verifying', 'failed', 'cancelled', 'interrupted'],
  verifying: ['completed', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: []
}

export const AGENT_LIMITS = {
  maxIterations: 6,
  maxToolCalls: 16,
  requestTimeoutMs: 45_000,
  maxToolOutputChars: 12_000,
  maxContextChars: 80_000,
  maxOutputTokens: 4_096,
  maxListEntries: 200,
  maxSearchResults: 40,
  maxStoredTextChars: 32_000,
  serviceRetries: 2
} as const

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
    state: z.enum(['started', 'finished', 'rejected']),
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
    summary: z.string().max(4_000)
  })
])

export type AgentEvent = z.infer<typeof agentEventSchema>

export const agentSubmitSchema = z.strictObject({
  prompt: z.string().min(1).max(8_000)
})

export const agentCancelSchema = z.strictObject({
  missionId: z
    .string()
    .min(36)
    .max(36)
    .refine((value) => /^[0-9a-f-]{36}$/i.test(value), invalid)
})

export type AgentMissionSummary = {
  id: string
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

export type AgentToolRecord = {
  callId: string
  name: string
  argumentsText: string
  state: 'started' | 'finished' | 'rejected'
  output: string
}

export type AgentTranscript = {
  mission: AgentMissionSummary
  messages: Array<{ role: string; content: string }>
  tools: AgentToolRecord[]
}
