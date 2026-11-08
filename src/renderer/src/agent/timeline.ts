import type {
  AgentMissionSummary,
  AgentOperationSummary,
  AgentToolRecord,
  MissionStatus
} from '../../../shared/agent.ts'
import { splitAssistantReport, type ConversationEntry } from '../conversation.ts'
import { humanToolVerb, toolTarget } from './statusMachine.ts'

export type TimelineItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant_text'; id: string; text: string; muted?: boolean }
  | {
      kind: 'step_group'
      id: string
      label: string
      count: number
      collapsed: boolean
      steps: TimelineStep[]
    }
  | { kind: 'command'; id: string; step: CommandStep }
  | { kind: 'edit'; id: string; step: EditStep }
  | { kind: 'approval'; id: string; operation: AgentOperationSummary }
  | { kind: 'error'; id: string; message: string }
  | { kind: 'verification'; id: string; step: CommandStep }
  | { kind: 'final_result'; id: string; result: FinalResult }

export type TimelineStep = {
  id: string
  /** All tool call ids represented by this step (includes collapsed retries). */
  ids: string[]
  toolName: string
  label: string
  target: string
  state: 'running' | 'success' | 'failed' | 'rejected' | 'waiting'
  durationMs?: number
  error?: string
  retries?: number
  attempts?: Array<{ state: string; error?: string; argumentsText: string }>
  output?: string
  argumentsText: string
}

export type CommandStep = TimelineStep & {
  command: string
  cwd?: string
  exitCode?: number | null
  stderr?: string
  stdout?: string
  diagnosis?: string
}

export type EditStep = TimelineStep & {
  path: string
  changeKind: 'create' | 'edit' | 'delete' | 'rename'
  additions?: number
  deletions?: number
  diff?: string
}

export type FinalResultStatus =
  | 'completed_verified'
  | 'completed_unverified'
  | 'partially_completed'
  | 'failed'
  | 'cancelled'
  | 'stopped_limit'
  | 'blocked'

export type FinalResult = {
  status: FinalResultStatus
  title: string
  outcome: string
  done: string[]
  notDone: string[]
  verification: string
  verificationLines: string[]
  nextStep?: string
  verified: boolean
  staleVerification?: boolean
  invalidCallNote?: string
  statusReason?: string
  /** Trace-only raw ledger extracted from legacy summary text. */
  reportLedger?: string | null
}

const READ_TOOLS = new Set(['list_files', 'read_file', 'search_files', 'get_workspace_info', 'list_file_operations'])
const EDIT_TOOLS = new Set(['create_file', 'edit_file', 'delete_file', 'rename_file', 'restore_file'])
/** Mirrors `isVerificationCommand` in main/agent/progress.ts — do not diverge. */
function isVerificationCommand(label: string): boolean {
  return (
    /\b(npm|pnpm|yarn|bun|npx|expo|tsc|eslint|prettier|cargo|go|dotnet|flutter|python|pip|uv)\b/i.test(label) &&
    /\b(install|ci|build|test|typecheck|lint|check|doctor|vitest|jest|expo-doctor)\b/i.test(label)
  )
}

/** Broader UI classifier for verification/check cards (includes bare tsc/eslint). */
function isCheckCommand(label: string): boolean {
  return isVerificationCommand(label) || /\b(tsc|eslint|vitest|jest|typecheck|expo-doctor)\b/i.test(label)
}

export function buildTimeline(input: {
  messages: ConversationEntry[]
  tools: AgentToolRecord[]
  operations: AgentOperationSummary[]
  mission: AgentMissionSummary | null
  notice?: string
}): TimelineItem[] {
  const items: TimelineItem[] = []
  const usedToolIds = new Set<string>()

  let legacyLedger: string | null = null
  for (const entry of input.messages) {
    if (entry.role === 'user') {
      items.push({ kind: 'user', id: entry.key, text: entry.content })
      continue
    }
    const split = splitAssistantReport(entry.content)
    if (split.ledger) {
      legacyLedger = split.ledger
    }
    const prose = collapseNarration(split.prose)
    if (prose.text) {
      items.push({
        kind: 'assistant_text',
        id: `${entry.key}-text`,
        text: prose.text,
        muted: prose.muted
      })
    }
    const missionOps = input.operations.filter((op) => !input.mission || op.missionId === input.mission.id)
    const activityTools = entry.activities
      .map((activity) => input.tools.find((tool) => tool.callId === activity.callId))
      .filter((tool): tool is AgentToolRecord => Boolean(tool))
    const grouped = groupTools(activityTools.length > 0 ? activityTools : [], missionOps)
    for (const item of grouped) {
      markUsed(item, usedToolIds)
      items.push(item)
    }
  }

  const missionOps = input.operations.filter((op) => !input.mission || op.missionId === input.mission.id)
  const remaining = input.tools.filter((tool) => !usedToolIds.has(tool.callId) && tool.name !== 'submit_result')
  for (const item of groupTools(remaining, missionOps)) {
    items.push(item)
  }

  for (const operation of missionOps.filter((item) => item.status === 'pending' && item.kind === 'delete')) {
    items.push({ kind: 'approval', id: `approval-${operation.id}`, operation })
  }

  if (input.notice?.trim()) {
    items.push({ kind: 'error', id: 'notice', message: input.notice.trim() })
  }

  if (input.mission && isTerminal(input.mission.status)) {
    const result = buildFinalResult(input.mission, input.tools, missionOps)
    result.reportLedger = legacyLedger
    items.push({
      kind: 'final_result',
      id: `final-${input.mission.id}`,
      result
    })
  }

  return items
}

function markUsed(item: TimelineItem, used: Set<string>): void {
  if (item.kind === 'step_group') {
    for (const step of item.steps) {
      for (const id of step.ids) used.add(id)
    }
  }
  if (item.kind === 'command' || item.kind === 'edit' || item.kind === 'verification') {
    for (const id of item.step.ids) used.add(id)
  }
}

function groupTools(tools: AgentToolRecord[], operations: AgentOperationSummary[] = []): TimelineItem[] {
  const collapsed = collapseRetries(tools)
  const items: TimelineItem[] = []
  let readBuffer: TimelineStep[] = []

  const flushReads = (): void => {
    if (readBuffer.length === 0) return
    items.push({
      kind: 'step_group',
      id: `explore-${readBuffer[0]!.id}`,
      label: `Explored ${readBuffer.length} file${readBuffer.length === 1 ? '' : 's'}`,
      count: readBuffer.length,
      collapsed: true,
      steps: readBuffer
    })
    readBuffer = []
  }

  for (const tool of collapsed) {
    if (READ_TOOLS.has(tool.name)) {
      readBuffer.push(toStep(tool))
      continue
    }
    flushReads()
    if (tool.name === 'run_command') {
      if (isInvalidCall(tool)) {
        // Invalid calls stay in attempts of a later retry if collapsed; otherwise omit from Chat.
        continue
      }
      const step = toCommandStep(tool)
      items.push({
        kind: isCheckCommand(step.command) ? 'verification' : 'command',
        id: step.id,
        step
      })
      continue
    }
    if (EDIT_TOOLS.has(tool.name)) {
      items.push({ kind: 'edit', id: tool.callId, step: toEditStep(tool, operations) })
      continue
    }
  }
  flushReads()
  return items
}

type CollapsedTool = AgentToolRecord & {
  __retries?: number
  __attempts?: TimelineStep['attempts']
  __attemptIds?: string[]
}

function collapseRetries(tools: AgentToolRecord[]): AgentToolRecord[] {
  const result: CollapsedTool[] = []
  for (const tool of tools) {
    const prev = result[result.length - 1]
    if (
      prev &&
      prev.name === tool.name &&
      toolTarget(prev.name, prev.argumentsText) === toolTarget(tool.name, tool.argumentsText) &&
      (prev.state === 'rejected' || prev.state === 'failed') &&
      (tool.state === 'success' || tool.state === 'finished' || tool.state === 'awaiting_approval' || tool.state === 'started')
    ) {
      const retries = (prev.__retries ?? 0) + 1
      const attempts = [
        ...(prev.__attempts ?? [{ state: prev.state, error: extractError(prev.output), argumentsText: prev.argumentsText }]),
        { state: tool.state, error: extractError(tool.output), argumentsText: tool.argumentsText }
      ]
      result[result.length - 1] = {
        ...tool,
        __retries: retries,
        __attempts: attempts,
        __attemptIds: [...(prev.__attemptIds ?? [prev.callId]), tool.callId]
      }
      continue
    }
    result.push({ ...tool, __attemptIds: [tool.callId] })
  }
  return result
}

function toStep(tool: AgentToolRecord): TimelineStep {
  const extra = tool as CollapsedTool
  return {
    id: tool.callId,
    ids: extra.__attemptIds ?? [tool.callId],
    toolName: tool.name,
    label: humanToolVerb(tool.name),
    target: toolTarget(tool.name, tool.argumentsText),
    state: mapState(tool.state),
    error: extractError(tool.output),
    retries: extra.__retries,
    attempts: extra.__attempts,
    output: tool.output,
    argumentsText: tool.argumentsText
  }
}

function toCommandStep(tool: AgentToolRecord): CommandStep {
  const base = toStep(tool)
  const payload = parseJson(tool.output)
  const preview = parseJson(tool.argumentsText)
  const command =
    typeof payload.command === 'string'
      ? [payload.command, ...(Array.isArray(payload.args) ? payload.args : [])].join(' ')
      : base.target
  const warnings = Array.isArray(payload.warnings) ? payload.warnings.map(String) : []
  return {
    ...base,
    command,
    cwd:
      typeof payload.workingDirectory === 'string'
        ? payload.workingDirectory
        : typeof preview.working_directory === 'string'
          ? preview.working_directory
          : undefined,
    exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
    stdout: typeof payload.stdout === 'string' ? payload.stdout : undefined,
    stderr: typeof payload.stderr === 'string' ? payload.stderr : undefined,
    diagnosis: warnings[0] ?? (typeof payload.note === 'string' ? payload.note : undefined),
    durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : base.durationMs
  }
}

function toEditStep(tool: AgentToolRecord, operations: AgentOperationSummary[] = []): EditStep {
  const base = toStep(tool)
  const path = base.target || 'file'
  const changeKind =
    tool.name === 'create_file'
      ? 'create'
      : tool.name === 'delete_file'
        ? 'delete'
        : tool.name === 'rename_file'
          ? 'rename'
          : 'edit'
  const operation =
    operations.find((item) => item.callId === tool.callId) ??
    operations.find((item) => item.path === path && item.status === 'applied')
  const stats = operation ? diffStats(operation.unifiedDiff) : { additions: undefined, deletions: undefined }
  return {
    ...base,
    path,
    changeKind,
    additions: stats.additions,
    deletions: stats.deletions,
    diff: operation?.unifiedDiff || undefined,
    label:
      changeKind === 'create'
        ? `Created ${path}`
        : changeKind === 'delete'
          ? `Deleted ${path}`
          : changeKind === 'rename'
            ? `Renamed ${path}`
            : `Edited ${path}`
  }
}

function diffStats(diff: string): { additions?: number; deletions?: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

export function buildFinalResult(
  mission: AgentMissionSummary,
  tools: AgentToolRecord[],
  operations: AgentOperationSummary[],
  options?: { earlierOperations?: AgentOperationSummary[] }
): FinalResult {
  // Mission-scope only — never mix other missions' operations into this card.
  const missionOps = operations.filter((item) => item.missionId === mission.id)
  const missionTools = tools.filter((tool) => {
    // Tools are already mission-scoped when loaded from a transcript; keep ops filter primary.
    return true
  })
  void options
  const commandTools = missionTools.filter((tool) => tool.name === 'run_command')
  const executed = commandTools.filter((tool) => toolWasExecuted(tool))
  const invalidCalls = commandTools.filter((tool) => isInvalidCall(tool))
  const checkRuns = executed.filter((tool) => isCheckCommand(toolTarget(tool.name, tool.argumentsText)))
  const unresolvedFails = unresolvedFailedCommandTools(executed)
  const applied = missionOps.filter((item) => item.status === 'applied')
  const failedOps = missionOps.filter((item) => item.status === 'failed' || item.status === 'rejected')

  const lastMutationAt = lastAppliedTimestamp(missionOps)
  const lastCheck = checkRuns[checkRuns.length - 1] ?? null
  const lastCheckPayload = lastCheck ? parseJson(lastCheck.output) : {}
  const lastCheckExit =
    typeof lastCheckPayload.exitCode === 'number'
      ? lastCheckPayload.exitCode
      : lastCheck && (lastCheck.state === 'success' || lastCheck.state === 'finished')
        ? 0
        : null
  const lastCheckPassed = lastCheckExit === 0
  const lastCheckAt = lastCheck?.createdAt ?? null
  const stale =
    lastCheckPassed &&
    Boolean(lastMutationAt && lastCheckAt && Date.parse(lastMutationAt) > Date.parse(lastCheckAt))
  const verified = mission.status === 'completed' && lastCheckPassed && !stale && Boolean(lastCheck)

  let status = mapFinalStatus(mission, verified)
  const limitStop = /iteration limit|exploration without action|budget exhausted|tool-call limit/i.test(
    `${mission.summary ?? ''}\n${mission.error ?? ''}`
  )
  if (limitStop && (status === 'failed' || status === 'partially_completed')) {
    status = 'stopped_limit'
  }
  if (mission.status === 'completed' && !verified) {
    status = 'completed_unverified'
  }
  if (mission.status === 'completed' && verified) {
    status = 'completed_verified'
  }

  const created = applied.filter((item) => item.kind === 'create').length
  const edited = applied.filter((item) => item.kind === 'edit').length
  const deleted = applied.filter((item) => item.kind === 'delete').length
  const done: string[] = []
  if (created || edited || deleted) {
    const parts: string[] = []
    if (created) parts.push(`${created} created`)
    if (edited) parts.push(`${edited} edited`)
    if (deleted) parts.push(`${deleted} deleted`)
    done.push(`Files: ${parts.join(', ')}`)
  } else if (applied.length > 0) {
    done.push(`${applied.length} file operation(s) applied`)
  }
  const okCommands = executed.filter((tool) => tool.state === 'success' || tool.state === 'finished')
  if (okCommands.length > 0) {
    done.push(`${okCommands.length} command${okCommands.length === 1 ? '' : 's'} succeeded`)
  }

  const notDone: string[] = []
  for (const tool of unresolvedFails) {
    const err = extractError(tool.output) || extractStderrLine(tool.output)
    notDone.push(`${toolTarget(tool.name, tool.argumentsText)}${err ? `: ${err}` : ''}`)
  }
  for (const op of failedOps) {
    notDone.push(`${op.kind} ${op.path}${op.error ? `: ${op.error}` : ''}`)
  }

  const verificationLines =
    checkRuns.length === 0
      ? ['No verification was run']
      : checkRuns.map((tool) => {
          const payload = parseJson(tool.output)
          if (typeof payload.exitCode !== 'number') {
            return `${toolTarget(tool.name, tool.argumentsText)} (no exit code recorded)`
          }
          return `${toolTarget(tool.name, tool.argumentsText)} (exit ${payload.exitCode})`
        })
  if (stale) {
    verificationLines.push('Verification is stale: files changed after the last passing check.')
  }
  const verification = verificationLines.join('; ')

  const statusReason =
    mission.status === 'completed' && !verified
      ? stale
        ? 'Verification is stale because files changed afterward.'
        : checkRuns.length === 0
          ? 'No verification command completed successfully.'
          : 'Last verification command did not exit 0.'
      : undefined

  return {
    status,
    title: finalTitle(status, verified),
    outcome: oneSentence(mission),
    done,
    notDone,
    verification,
    verificationLines,
    nextStep: suggestNext(mission, notDone, verified),
    verified,
    staleVerification: stale,
    invalidCallNote:
      invalidCalls.length >= 3 ? `The model sent ${invalidCalls.length} malformed tool calls` : undefined,
    statusReason,
    reportLedger: null
  }
}

function toolWasExecuted(tool: AgentToolRecord): boolean {
  const payload = parseJson(tool.output)
  return Object.prototype.hasOwnProperty.call(payload, 'exitCode')
}

function isInvalidCall(tool: AgentToolRecord): boolean {
  if (toolWasExecuted(tool)) return false
  const err = extractError(tool.output) ?? ''
  return /arguments were rejected|unrecognized key|expected string|invalid input/i.test(err) || tool.state === 'rejected'
}

function normalizeCommandKey(label: string, cwd = '.'): string {
  return `${cwd.trim() || '.'}\0${label.trim().replace(/\s+/g, ' ')}`
}

function unresolvedFailedCommandTools(executed: AgentToolRecord[]): AgentToolRecord[] {
  const unresolved: AgentToolRecord[] = []
  for (let index = 0; index < executed.length; index += 1) {
    const tool = executed[index]!
    const payload = parseJson(tool.output)
    const failed =
      tool.state === 'failed' ||
      tool.state === 'cancelled' ||
      (typeof payload.exitCode === 'number' && payload.exitCode !== 0)
    if (!failed) continue
    const label = toolTarget(tool.name, tool.argumentsText)
    const cwd = typeof payload.workingDirectory === 'string' ? payload.workingDirectory : '.'
    const key = normalizeCommandKey(label, cwd)
    const laterOk = executed.slice(index + 1).some((later) => {
      const laterPayload = parseJson(later.output)
      const laterLabel = toolTarget(later.name, later.argumentsText)
      const laterCwd =
        typeof laterPayload.workingDirectory === 'string' ? laterPayload.workingDirectory : '.'
      return (
        (later.state === 'success' || later.state === 'finished') &&
        laterPayload.exitCode === 0 &&
        normalizeCommandKey(laterLabel, laterCwd) === key
      )
    })
    if (!laterOk) unresolved.push(tool)
  }
  return unresolved
}

function lastAppliedTimestamp(operations: AgentOperationSummary[]): string | null {
  let latest: string | null = null
  for (const op of operations) {
    if (op.status !== 'applied') continue
    const stamp = op.resolvedAt || op.createdAt
    if (!stamp) continue
    if (!latest || Date.parse(stamp) >= Date.parse(latest)) latest = stamp
  }
  return latest
}

function mapFinalStatus(mission: AgentMissionSummary, verified: boolean): FinalResultStatus {
  switch (mission.status) {
    case 'completed':
      return verified ? 'completed_verified' : 'completed_unverified'
    case 'partially_completed':
      return 'partially_completed'
    case 'cancelled':
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
      return 'blocked'
    default:
      return 'failed'
  }
}

function finalTitle(status: FinalResultStatus, verified: boolean): string {
  switch (status) {
    case 'completed_verified':
      return 'Completed · Verified'
    case 'completed_unverified':
      return 'Completed (unverified)'
    case 'partially_completed':
      return 'Partially completed'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'stopped_limit':
      return 'Stopped (limit reached)'
    case 'blocked':
      return 'Blocked'
    default:
      return verified ? 'Completed · Verified' : 'Completed (unverified)'
  }
}

function oneSentence(mission: AgentMissionSummary): string {
  const summary = mission.summary?.trim()
  if (!summary) {
    return mission.error?.trim() || `Mission ended as ${mission.status.replaceAll('_', ' ')}.`
  }
  const first = summary.split('\n').find((line) => line.trim() && !line.startsWith('Proposed') && !line.startsWith('Applied'))
  return (first ?? summary).slice(0, 240)
}

function suggestNext(mission: AgentMissionSummary, notDone: string[], verified: boolean): string | undefined {
  if (notDone.length > 0) {
    return `Address: ${notDone[0]!.slice(0, 120)}`
  }
  if (!verified && (mission.status === 'completed' || mission.status === 'partially_completed')) {
    return 'Run a verification command (typecheck, test, or lint).'
  }
  if (/exploration without action/i.test(`${mission.summary ?? ''}\n${mission.error ?? ''}`)) {
    return 'Ask again; propose the action from the discovered paths.'
  }
  return undefined
}

function collapseNarration(content: string): { text: string; muted: boolean } {
  const lines = content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const unique: string[] = []
  for (const line of lines) {
    const norm = line.toLowerCase().replace(/[.…]+$/g, '').replace(/\s+/g, ' ')
    const prev = unique[unique.length - 1]?.toLowerCase().replace(/[.…]+$/g, '').replace(/\s+/g, ' ')
    if (prev === norm) continue
    unique.push(line)
  }
  const text = unique.join('\n')
  const muted =
    unique.length > 0 &&
    unique.every(
      (line) => line.length < 100 && /^(checking|gathering|looking|inspecting|reading|listing|still|waiting)/i.test(line)
    )
  return { text, muted }
}

function mapState(state: string): TimelineStep['state'] {
  if (state === 'started' || state === 'running') return 'running'
  if (state === 'awaiting_approval') return 'waiting'
  if (state === 'rejected') return 'rejected'
  if (state === 'failed' || state === 'cancelled') return 'failed'
  return 'success'
}

function extractError(output?: string): string | undefined {
  if (!output) return undefined
  const payload = parseJson(output)
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error.trim().slice(0, 240)
  }
  return undefined
}

function extractStderrLine(output?: string): string | undefined {
  const payload = parseJson(output ?? '')
  if (typeof payload.stderr === 'string' && payload.stderr.trim()) {
    return payload.stderr.trim().split(/\n/).find((line) => line.trim())?.slice(0, 200)
  }
  return undefined
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function isTerminal(status: MissionStatus): boolean {
  return (
    status === 'completed' ||
    status === 'partially_completed' ||
    status === 'failed' ||
    status === 'blocked' ||
    status === 'cancelled' ||
    status === 'interrupted'
  )
}
