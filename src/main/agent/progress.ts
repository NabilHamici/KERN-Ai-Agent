import type { AgentOperationSummary, MissionStatus } from '../../shared/agent.ts'
import type { ToolExecution } from './tools.ts'

export type ToolOutcome = 'success' | 'rejected' | 'awaiting_approval' | 'failed' | 'cancelled'

export type CommandRecordKind = 'executed' | 'invalid_call' | 'rejected_by_policy'

export type CommandRecord = {
  label: string
  status: string
  detail?: string
  nextSteps?: string
  exitCode?: number | null
  cwd?: string
  kind?: CommandRecordKind
  sequence?: number
}

export type ProgressSnapshot = {
  proposed: string[]
  approvedOrApplied: string[]
  applied: string[]
  failed: string[]
  rejected: string[]
  awaitingApproval: string[]
  pendingDeletions: string[]
  cancelled: string[]
  verifiedReads: string[]
  commands: CommandRecord[]
  exploredPaths?: string[]
  readOnlyCalls?: number
  productiveCalls?: number
  /** Sequence index of the last successful file mutation in this mission. */
  lastMutationSequence?: number
  invalidCallCount?: number
}

export type ClaimedCompletion = {
  outcome: 'completed' | 'blocked' | 'partially_completed'
  summary: string
}

export function toolFingerprint(name: string, argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as unknown
    return `${name}:${stableJson(parsed)}`
  } catch {
    return `${name}:${argumentsText.trim()}`
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

export function withOutcome(payload: Record<string, unknown>, outcome: ToolOutcome): ToolExecution {
  const body = { outcome, ...payload }
  const output = JSON.stringify(body)
  const state =
    outcome === 'success'
      ? 'success'
      : outcome === 'awaiting_approval'
        ? 'awaiting_approval'
        : outcome === 'cancelled'
          ? 'cancelled'
          : outcome === 'failed'
            ? 'failed'
            : 'rejected'
  return { state, output }
}

export function snapshotFromOperations(
  operations: AgentOperationSummary[],
  verifiedReads: Iterable<string> = []
): ProgressSnapshot {
  const proposed: string[] = []
  const approvedOrApplied: string[] = []
  const applied: string[] = []
  const failed: string[] = []
  const rejected: string[] = []
  const awaitingApproval: string[] = []
  const pendingDeletions: string[] = []
  const cancelled: string[] = []
  for (const operation of operations) {
    const label = operation.toPath ? `${operation.path} → ${operation.toPath}` : operation.path
    if (operation.status === 'pending' || operation.status === 'approved') {
      proposed.push(label)
      awaitingApproval.push(label)
      if (operation.kind === 'delete') {
        pendingDeletions.push(label)
      }
      if (operation.status === 'approved') {
        approvedOrApplied.push(label)
      }
    } else if (operation.status === 'applied') {
      applied.push(label)
      approvedOrApplied.push(label)
    } else if (operation.status === 'failed') {
      failed.push(label)
    } else if (operation.status === 'rejected') {
      rejected.push(label)
    } else if (operation.status === 'cancelled' || operation.status === 'stale') {
      cancelled.push(label)
    }
  }
  return {
    proposed: unique(proposed),
    approvedOrApplied: unique(approvedOrApplied),
    applied: unique(applied),
    failed: unique(failed),
    rejected: unique(rejected),
    awaitingApproval: unique(awaitingApproval),
    pendingDeletions: unique(pendingDeletions),
    cancelled: unique(cancelled),
    verifiedReads: unique([...verifiedReads]),
    commands: []
  }
}

/** Normalized identity for retry/resolve matching. */
export function normalizeCommandKey(label: string, cwd = '.'): string {
  return `${cwd.trim() || '.'}\0${label.trim().replace(/\s+/g, ' ')}`
}

export function isVerificationCommand(label: string): boolean {
  return (
    /\b(npm|pnpm|yarn|bun|npx|expo|tsc|eslint|prettier|cargo|go|dotnet|flutter|python|pip|uv)\b/i.test(label) &&
    /\b(install|ci|build|test|typecheck|lint|check|doctor|vitest|jest|expo-doctor)\b/i.test(label)
  )
}

/** Broader check for UI/timeline (includes bare tsc). */
export function isCheckCommand(label: string): boolean {
  return isVerificationCommand(label) || /\b(tsc|eslint|vitest|jest|typecheck|expo-doctor)\b/i.test(label)
}

export function executedCommands(commands: CommandRecord[]): CommandRecord[] {
  return commands.filter((command) => (command.kind ?? 'executed') === 'executed')
}

export function invalidCallCount(commands: CommandRecord[]): number {
  return commands.filter((command) => command.kind === 'invalid_call').length
}

/**
 * A failed executed command is resolved when a later executed command with the same
 * normalized command line + cwd completed successfully.
 */
export function unresolvedFailedCommands(commands: CommandRecord[]): CommandRecord[] {
  const executed = executedCommands(commands)
  const unresolved: CommandRecord[] = []
  for (let index = 0; index < executed.length; index += 1) {
    const command = executed[index]!
    if (command.status === 'completed') {
      continue
    }
    if (command.status !== 'failed' && command.status !== 'cancelled' && command.status !== 'timed_out') {
      continue
    }
    const key = normalizeCommandKey(command.label, command.cwd)
    const laterSuccess = executed.slice(index + 1).some(
      (later) => later.status === 'completed' && normalizeCommandKey(later.label, later.cwd) === key
    )
    if (!laterSuccess) {
      unresolved.push(command)
    }
  }
  return unresolved
}

export type VerificationAssessment = {
  verified: boolean
  stale: boolean
  noneRun: boolean
  lastLabel: string | null
  lastExitCode: number | null
  note: string
}

export function assessVerification(
  commands: CommandRecord[],
  lastMutationSequence: number | null | undefined
): VerificationAssessment {
  const checks = executedCommands(commands).filter((command) => isCheckCommand(command.label))
  if (checks.length === 0) {
    return {
      verified: false,
      stale: false,
      noneRun: true,
      lastLabel: null,
      lastExitCode: null,
      note: 'No verification was run'
    }
  }
  const last = checks[checks.length - 1]!
  const lastSeq = last.sequence ?? checks.length - 1
  const exitOk = last.status === 'completed' && (last.exitCode === 0 || last.exitCode === undefined || last.exitCode === null)
  // Prefer explicit exitCode when present.
  const exitCode =
    typeof last.exitCode === 'number' ? last.exitCode : last.status === 'completed' ? 0 : null
  const passed = last.status === 'completed' && (exitCode === null || exitCode === 0)
  const mutationAfter =
    typeof lastMutationSequence === 'number' ? lastMutationSequence > lastSeq : false
  if (passed && !mutationAfter) {
    return {
      verified: true,
      stale: false,
      noneRun: false,
      lastLabel: last.label,
      lastExitCode: exitCode,
      note: `${last.label} (exit ${exitCode ?? 0})`
    }
  }
  if (passed && mutationAfter) {
    return {
      verified: false,
      stale: true,
      noneRun: false,
      lastLabel: last.label,
      lastExitCode: exitCode,
      note: `Verification is stale: files changed after ${last.label} (exit ${exitCode ?? 0})`
    }
  }
  return {
    verified: false,
    stale: false,
    noneRun: false,
    lastLabel: last.label,
    lastExitCode: exitCode,
    note: `${last.label} (exit ${exitCode ?? 'nonzero'})`
  }
}

/** Compact ledger for model context — no discovered-paths dump. */
export function compactLedger(snapshot: ProgressSnapshot): string {
  const unresolved = unresolvedFailedCommands(snapshot.commands)
  const verification = assessVerification(snapshot.commands, snapshot.lastMutationSequence)
  const invalid = snapshot.invalidCallCount ?? invalidCallCount(snapshot.commands)
  const lines = [
    'Compact execution record:',
    `Applied files: ${snapshot.applied.length === 0 ? '(none)' : snapshot.applied.join(', ')}`,
    `Pending deletions: ${snapshot.pendingDeletions.length === 0 ? '(none)' : snapshot.pendingDeletions.join(', ')}`,
    `Unresolved command failures: ${
      unresolved.length === 0
        ? '(none)'
        : unresolved.map((command) => `${command.label} (${command.status})`).join('; ')
    }`,
    `Commands run: ${executedCommands(snapshot.commands).length}`,
    `Verification: ${verification.note}`,
    invalid > 0 ? `Malformed tool calls: ${invalid}` : null,
    snapshot.exploredPaths && snapshot.exploredPaths.length > 0
      ? `Exploration covered ${snapshot.exploredPaths.length} path(s) (details omitted).`
      : null
  ].filter((line): line is string => line !== null)
  return lines.join('\n')
}

/** Full ledger for Trace / debug only — never put into Chat bubbles or model context. */
export function reportLedger(snapshot: ProgressSnapshot, preface?: string): string {
  const appliedSet = new Set(snapshot.applied.map(appliedPath))
  const failedSet = new Set(snapshot.failed.map(appliedPath))
  const writeConfirmed = snapshot.verifiedReads.filter((path) => appliedSet.has(path) && !failedSet.has(path))
  const lines = [
    preface?.trim() || 'Mission progress based on persisted execution records:',
    `Proposed this mission: ${formatList(snapshot.proposed)}`,
    `Applied this mission: ${formatList(snapshot.applied)}`,
    `Awaiting deletion approval: ${formatList(snapshot.pendingDeletions)}`,
    `Awaiting approval: ${formatList(snapshot.awaitingApproval)}`,
    `Failed operations: ${formatList(snapshot.failed)}`,
    `Rejected operations: ${formatList(snapshot.rejected)}`,
    `Cancelled/stale: ${formatList(snapshot.cancelled)}`,
    writeConfirmed.length > 0 ? `Write confirmed by read: ${formatList(writeConfirmed)}` : null,
    `Commands: ${formatCommands(executedCommands(snapshot.commands))}`,
    snapshot.exploredPaths && snapshot.exploredPaths.length > 0
      ? `Discovered during exploration: ${formatList(snapshot.exploredPaths.slice(0, 80))}`
      : null
  ].filter((line): line is string => line !== null)
  return lines.join('\n')
}

/** @deprecated Prefer reportLedger for Trace and compactLedger for the model. */
export function honestSummary(snapshot: ProgressSnapshot, preface?: string): string {
  return reportLedger(snapshot, preface)
}

function clampProse(text: string, maxLines = 5): string {
  const cleaned = stripLedgerHeaders(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
  return cleaned.join('\n').slice(0, 1_200)
}

export const LEDGER_HEADER_RE =
  /^(Proposed this mission|Applied this mission|Awaiting deletion approval|Awaiting approval|Failed operations|Rejected operations|Cancelled\/stale|Write confirmed by read|Commands:|Discovered during exploration|Mission progress based on|Note: reading a file after writing)/i

export function stripLedgerHeaders(text: string): string {
  return text
    .split(/\n/)
    .filter((line) => !LEDGER_HEADER_RE.test(line.trim()))
    .join('\n')
    .trim()
}

export function splitProseAndLedger(text: string): { prose: string; ledger: string | null } {
  const lines = text.split(/\n/)
  const proseLines: string[] = []
  const ledgerLines: string[] = []
  let inLedger = false
  for (const line of lines) {
    if (LEDGER_HEADER_RE.test(line.trim()) || /^Note: reading a file after writing/i.test(line.trim())) {
      inLedger = true
    }
    if (inLedger) {
      ledgerLines.push(line)
    } else {
      proseLines.push(line)
    }
  }
  const prose = proseLines.join('\n').trim()
  const ledger = ledgerLines.join('\n').trim()
  return { prose, ledger: ledger.length > 0 ? ledger : null }
}

export function resolveClaimedCompletion(
  claimed: ClaimedCompletion,
  snapshot: ProgressSnapshot
): { status: MissionStatus; summary: string; error: string | null; ledger: string } {
  const onlyPendingDeletions =
    snapshot.awaitingApproval.length > 0 &&
    snapshot.awaitingApproval.length === snapshot.pendingDeletions.length
  const prose = clampProse(claimed.summary)
  const ledger = reportLedger(snapshot, claimed.summary)
  const unresolvedCommands = unresolvedFailedCommands(snapshot.commands)
  const verification = assessVerification(snapshot.commands, snapshot.lastMutationSequence)

  if (snapshot.awaitingApproval.length > 0) {
    if (onlyPendingDeletions && snapshot.applied.length > 0 && claimed.outcome !== 'blocked') {
      return {
        status: 'partially_completed',
        summary: withStatusNote(prose, 'Deletions still await approval.'),
        error: null,
        ledger
      }
    }
    return {
      status: 'blocked',
      summary: withStatusNote(prose, 'File proposals still await approval.'),
      error: 'One or more file proposals are still awaiting approval.',
      ledger
    }
  }
  if (claimed.outcome === 'blocked') {
    return { status: 'blocked', summary: prose, error: claimed.summary, ledger }
  }
  if (claimed.outcome === 'partially_completed') {
    return { status: 'partially_completed', summary: prose, error: null, ledger }
  }
  if (snapshot.failed.length > 0) {
    return {
      status: 'partially_completed',
      summary: withStatusNote(prose, 'Some file operations failed.'),
      error: null,
      ledger
    }
  }
  if (claimed.outcome === 'completed' && snapshot.applied.length === 0 && snapshot.proposed.length > 0) {
    return {
      status: 'blocked',
      summary: withStatusNote(prose, 'No file operations were applied.'),
      error: 'No file operations were applied.',
      ledger
    }
  }
  if (claimed.outcome === 'completed' && unresolvedCommands.length > 0) {
    return {
      status: 'partially_completed',
      summary: withStatusNote(
        prose,
        `Unresolved command failure: ${unresolvedCommands[0]!.label}.`
      ),
      error: null,
      ledger
    }
  }
  if (claimed.outcome === 'completed' && snapshot.applied.length > 0) {
    const unverified = snapshot.applied.filter((label) => !snapshot.verifiedReads.includes(appliedPath(label)))
    const successfulVerification = executedCommands(snapshot.commands).some(
      (command) => command.status === 'completed' && isVerificationCommand(command.label)
    )
    if (unverified.length > 0 && !successfulVerification && verification.noneRun) {
      return {
        status: 'partially_completed',
        summary: withStatusNote(prose, 'Applied files were not read back and no verification command ran.'),
        error: null,
        ledger
      }
    }
  }
  if (
    claimed.outcome === 'completed' &&
    verification.noneRun &&
    /\bverif(?:y|ied|ication)\b/i.test(claimed.summary)
  ) {
    return {
      status: 'partially_completed',
      summary: withStatusNote(
        prose,
        'Claimed verification was refused: no install/build/test/typecheck/lint/check command completed successfully.'
      ),
      error: null,
      ledger
    }
  }
  const statusNote =
    snapshot.applied.length > 0 && verification.noneRun
      ? 'Completed without a recorded verification command.'
      : verification.stale
        ? 'Completed, but verification is stale because files changed afterward.'
        : null
  return {
    status: 'completed',
    summary: statusNote ? withStatusNote(prose, statusNote) : prose,
    error: null,
    ledger
  }
}

function withStatusNote(prose: string, note: string): string {
  if (!prose) {
    return note
  }
  if (prose.includes(note)) {
    return prose
  }
  return `${prose}\n${note}`
}

function appliedPath(label: string): string {
  const arrow = label.split(' → ')
  return arrow.length === 2 ? arrow[1]! : label
}

export function limitStopResult(
  snapshot: ProgressSnapshot,
  reason: string,
  options?: { taskPrompt?: string }
): {
  status: MissionStatus
  summary: string
  error: string | null
  ledger: string
} {
  const onlyPendingDeletions =
    snapshot.awaitingApproval.length > 0 &&
    snapshot.awaitingApproval.length === snapshot.pendingDeletions.length
  const shortReason = clampProse(reason, 3)
  const ledger = reportLedger(snapshot, reason)

  if (snapshot.awaitingApproval.length > 0) {
    if (onlyPendingDeletions && snapshot.applied.length > 0) {
      return { status: 'partially_completed', summary: shortReason, error: null, ledger }
    }
    return { status: 'blocked', summary: shortReason, error: reason, ledger }
  }
  if (
    snapshot.applied.length > 0 ||
    snapshot.failed.length > 0 ||
    snapshot.rejected.length > 0 ||
    executedCommands(snapshot.commands).length > 0
  ) {
    return {
      status: 'partially_completed',
      summary: withStatusNote(shortReason, 'Mission stopped before verification finished.'),
      error: null,
      ledger
    }
  }
  const explored = snapshot.exploredPaths ?? []
  const nothingDone =
    snapshot.proposed.length === 0 &&
    snapshot.applied.length === 0 &&
    executedCommands(snapshot.commands).length === 0
  if (nothingDone) {
    const task = options?.taskPrompt?.trim() || 'the requested task'
    const listed =
      explored.length > 0
        ? `Exploration covered ${explored.length} path(s).`
        : 'No durable inventory was retained.'
    const next =
      explored.length > 0
        ? 'Next step: ask again; propose the action from the discovered paths in one approval.'
        : 'Next step: ask again and call list_files with recursive:true once, then propose the action.'
    const summary = clampProse([reason, `Task required: ${task}`, `What happened: ${listed} No mutations or commands were proposed.`, next].join('\n'))
    return { status: 'failed', summary, error: reason, ledger }
  }
  return { status: 'failed', summary: shortReason, error: reason, ledger }
}

function formatList(values: string[]): string {
  return values.length === 0 ? '(none)' : values.join(', ')
}

function formatCommands(commands: CommandRecord[]): string {
  if (commands.length === 0) {
    return '(none)'
  }
  return commands
    .map((command) => {
      const parts = [`${command.label} (${command.status})`]
      if (typeof command.exitCode === 'number') {
        parts.push(`exit ${command.exitCode}`)
      }
      if (command.detail) {
        parts.push(`stderr: ${command.detail}`)
      }
      if (command.nextSteps) {
        parts.push(`next: ${command.nextSteps}`)
      }
      return parts.join(' — ')
    })
    .join('; ')
}

export function commandFailureHints(label: string, stderr: string, error: string | null): {
  detail?: string
  nextSteps?: string
} {
  const text = `${stderr}\n${error ?? ''}`.trim()
  const detail = text.length > 0 ? text.replace(/\s+/g, ' ').slice(0, 400) : undefined
  const packageManager = /\b(npm|pnpm|yarn|bun|npx|corepack)\b/i.test(label)
  const looksEnvironmental =
    /ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENOSPC|EEXIST|ENOENT|network|registry|certificate|proxy|cacache|no space left/i.test(
      text
    )
  if (!packageManager || !looksEnvironmental) {
    return { detail }
  }
  return {
    detail,
    nextSteps:
      'In a terminal from the project directory run: npm cache verify; then npm install. If it still fails, free disk space or upgrade npm (npm install -g npm@latest) and retry the same install command.'
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
