import {
  AGENT_LIMITS,
  assertTransition,
  isMutationTool,
  redactSensitive,
  type AgentOperationSummary,
  type MissionStatus
} from '../../shared/agent.ts'
import {
  commandFailureHints,
  compactLedger,
  limitStopResult,
  resolveClaimedCompletion,
  type CommandRecord,
  snapshotFromOperations,
  toolFingerprint,
  type ProgressSnapshot
} from './progress.ts'
import { commandPreview } from './commands.ts'
import { MODEL_TOOLS, parseCompletion, type ReadCache, type ToolExecution } from './tools.ts'
import { addUsage, type FunctionCall, type ProviderTurn, type TokenUsageReport } from './provider.ts'

export type ModelClient = (input: {
  instructions: string
  input: unknown[]
  tools: unknown[]
  signal: AbortSignal
  onDelta: (delta: string) => void
}) => Promise<ProviderTurn>

export type LoopResult = {
  status: MissionStatus
  summary: string | null
  error: string | null
  usage?: TokenUsageReport
}

function abortError(): Error {
  const error = new Error('The mission was cancelled.')
  error.name = 'AbortError'
  return error
}

function instructionsFor(workspaceName: string): string {
  return [
    `You are KERN, a controlled coding assistant for the workspace "${workspaceName}" on ${process.platform}.`,
    'You may list, read, and search files with the provided tools. Paths are relative to the workspace.',
    'The live filesystem is the single source of truth. list_file_operations returns persisted history, not disk state.',
    'For list_files and read_file, use "." for the workspace root. An empty path is treated as ".".',
    'list_files supports recursive:true or depth>1 for a nested tree in ONE call. Do not list directories one by one.',
    'search_files takes query (preferred) or pattern, with optional path. Example: {"query":"package.json"}. query ".", "*", or "**/*" returns the recursive tree; prefer list_files recursive:true for inventories.',
    'create_file, edit_file, rename_file apply automatically when safe. delete_file always waits for explicit user approval (including directory/bulk deletes).',
    'To remove many files, call list_files with recursive:true once, then delete_file with paths:[] and/or recursive:true on directories in ONE proposal. .git and .kern stay protected unless the user names them. node_modules is one regenerable directory entry.',
    'restore_file: path-based restore is current-mission only. Use an explicit operationId only when the user asked to recover a prior change. Never restore old scaffolds to create a new project.',
    'Do not ask the user to approve ordinary creates or edits. Continue working after successful automatic writes.',
    'If create_file targets a path that already exists, inspect or rely on the tool converting it into an edit. Prefer edit_file for intentional modifications.',
    'For multi-file work, create or edit several files in one turn when safe. Do not stop after the first file when the deliverable needs more.',
    'Before large scaffolds, inspect the workspace with list_files. If it is empty or missing a project, prefer the official generator for that stack through run_command instead of writing every file by hand.',
    'When unsure about generator flags (non-interactive confirm, skip install, template names), run the generator with --help first and use only documented flags. Prefer scaffolding without installing dependencies when the generator supports it, then run install as a separate run_command so scaffold success is not mixed with install failure.',
    'After scaffolding, inspect generated files, install dependencies in a separate command when needed, and run a real validation command when one exists.',
    'run_command takes an executable and an args array. Use working_directory (alias workingDirectory). It is not a shell string. Do not use Git, deletion commands, or paths outside the workspace.',
    'When a command fails, read its stderr/warnings, diagnose, retry at most twice with a different approach, then stop and report. Do not endlessly re-list the same directory. For package-manager/network/cache failures, include the real stderr in submit_result and tell the user the exact next commands to run (for example npm cache verify, then npm install in the project directory, or upgrade npm).',
    'Never claim a change was applied until a tool result says applied:true, restored:true, or noop:true. For deletions, wait until applied:true after user approval.',
    'Never claim a command, install, or app launch succeeded unless a run_command result has status completed and exitCode 0 and no install/network warnings. Reading a file after writing is write confirmation, not task verification.',
    'Inspect every tool result outcome field (success, rejected, awaiting_approval, failed, cancelled) before the next action.',
    'If a tool is rejected for schema reasons, correct the argument names using the error example. Do not repeat the identical invalid call.',
    'If a deletion is rejected, cancelled, or stale, do not retry the identical deletion. Continue unrelated safe work or call submit_result.',
    'Do not invent file contents.',
    'Plain text does not finish the mission. Call submit_result with outcome completed, partially_completed, or blocked and an honest summary grounded in tool results.',
    'Your submit_result summary must be at most 3-5 short lines: state the outcome, anything not done, and a single next step. Do not list files, commands, paths, or verification sections — the UI already shows those.'
  ].join(' ')
}

const INSPECTION_TOOLS = new Set(['list_files', 'read_file', 'search_files', 'get_workspace_info', 'list_file_operations'])

function invalidateInspectionFingerprints(store: Map<string, { count: number; lastOutput: string }>): void {
  for (const key of [...store.keys()]) {
    const name = key.slice(0, key.indexOf(':'))
    if (INSPECTION_TOOLS.has(name)) {
      store.delete(key)
    }
  }
}

function userItem(text: string): { role: 'user'; content: string } {
  return { role: 'user', content: text }
}

function parseToolPayload(output: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function normalizedNarration(text: string): string {
  return text.toLowerCase().replace(/[.…]+$/g, '').replace(/\s+/g, ' ').trim()
}

function isArgumentError(output: string): boolean {
  return /arguments were rejected|unrecognized key|expected string|invalid input/i.test(output)
}

export async function runAgentLoop(options: {
  prompt: string
  priorContext?: string | null
  workspaceName: string
  signal: AbortSignal
  secret: string
  client: ModelClient
  executeTool: (name: string, argumentsText: string, cache?: ReadCache) => ToolExecution
  runCommand?: (call: FunctionCall) => Promise<ToolExecution>
  proposeMutation: (call: FunctionCall) => {
    execution: ToolExecution
    operationId: string | null
  }
  waitForApprovals: (operationIds: string[]) => Promise<Array<{ callId: string; execution: ToolExecution }>>
  listOperations?: () => AgentOperationSummary[]
  onStatus: (status: MissionStatus) => void
  onText: (delta: string) => void
  onTool: (call: FunctionCall, execution: ToolExecution) => void
}): Promise<LoopResult> {
  const instructions = instructionsFor(options.workspaceName)
  let status: MissionStatus = 'queued'
  const move = (next: MissionStatus): void => {
    assertTransition(status, next)
    status = next
    options.onStatus(next)
  }
  move('analyzing')
  const seed: unknown[] = []
  if (options.priorContext && options.priorContext.trim().length > 0) {
    seed.push(userItem(options.priorContext))
    seed.push({
      role: 'assistant',
      content: 'I have the prior mission context from persisted history. I will use list_file_operations when recovery or earlier file actions matter.'
    })
  }
  let input: unknown[] = [...seed, userItem(options.prompt)]
  let toolCalls = 0
  let readOnlyCalls = 0
  let productiveCalls = 0
  let consecutiveReadOnly = 0
  let consecutiveArgumentErrors = 0
  let explorationWarned = false
  let usage: TokenUsageReport | undefined
  let emptyTurns = 0
  let stagnantTurns = 0
  let novelFailures = 0
  let lastProblem: string | null = null
  let lastNarration = ''
  const seenFingerprints = new Map<string, { count: number; lastOutput: string }>()
  const verifiedReads = new Set<string>()
  const exploredPaths = new Set<string>()
  const commandRecords: CommandRecord[] = []
  let sequence = 0
  let lastMutationSequence: number | undefined
  let invalidCalls = 0
  const outcome = (next: MissionStatus, summary: string | null, error: string | null): LoopResult => ({
    status: next,
    summary,
    error,
    usage
  })

  const currentSnapshot = (): ProgressSnapshot => ({
    ...snapshotFromOperations(options.listOperations?.() ?? [], verifiedReads),
    commands: commandRecords,
    exploredPaths: [...exploredPaths],
    readOnlyCalls,
    productiveCalls,
    lastMutationSequence,
    invalidCallCount: invalidCalls
  })

  const nextSequence = (): number => {
    sequence += 1
    return sequence
  }

  const rememberProblem = (state: string, output: string): void => {
    if (state === 'success') {
      return
    }
    const payload = parseToolPayload(output)
    let error = typeof payload.error === 'string' ? payload.error.trim() : ''
    // Prefer the original failure when the loop rejects an identical retry.
    if (/Identical .+ already/i.test(error) && typeof payload.priorOutput === 'string') {
      const prior = parseToolPayload(payload.priorOutput)
      if (typeof prior.error === 'string' && prior.error.trim()) {
        error = prior.error.trim()
      }
    }
    if (!error) {
      return
    }
    if (lastProblem && /Identical .+ already/i.test(error)) {
      return
    }
    lastProblem = error.slice(0, 500)
  }

  const stopFromLimit = (reason: string): LoopResult => {
    const detail = lastProblem ? `${reason} Last tool error: ${lastProblem}` : reason
    const resolved = limitStopResult(currentSnapshot(), detail, { taskPrompt: options.prompt })
    move(resolved.status)
    return outcome(resolved.status, resolved.summary, resolved.error)
  }

  const recordExplored = (name: string, argumentsText: string, output: string): void => {
    if (!INSPECTION_TOOLS.has(name)) {
      return
    }
    try {
      const args = JSON.parse(argumentsText) as { path?: unknown }
      if (typeof args.path === 'string' && args.path.trim()) {
        exploredPaths.add(args.path.trim())
      }
    } catch {
      // Ignore malformed args; the tool layer already rejected them.
    }
    const payload = parseToolPayload(output)
    if (Array.isArray(payload.entries)) {
      for (const entry of payload.entries.slice(0, 200)) {
        if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
          exploredPaths.add((entry as { path: string }).path)
        }
      }
    }
  }

  const emitText = (delta: string): void => {
    const trimmed = delta.trim()
    if (!trimmed) {
      options.onText(redactSensitive(delta, options.secret))
      return
    }
    if (trimmed === lastNarration || (lastNarration && normalizedNarration(trimmed) === normalizedNarration(lastNarration))) {
      return
    }
    lastNarration = trimmed
    options.onText(redactSensitive(delta, options.secret))
  }

  for (let iteration = 0; iteration < AGENT_LIMITS.maxIterations; iteration += 1) {
    if (options.signal.aborted) {
      throw abortError()
    }
    const requestSignal = AbortSignal.any([options.signal, AbortSignal.timeout(AGENT_LIMITS.requestTimeoutMs)])
    if (JSON.stringify(input).length + instructions.length > AGENT_LIMITS.maxContextChars) {
      return stopFromLimit('Mission context limit reached')
    }
    let turn: ProviderTurn
    try {
      turn = await options.client({
        instructions,
        input,
        tools: [...MODEL_TOOLS],
        signal: requestSignal,
        onDelta: (delta) => emitText(delta)
      })
    } catch (error) {
      if (options.signal.aborted) {
        throw abortError()
      }
      if (error instanceof Error && error.name === 'AbortError') {
        move('failed')
        return outcome('failed', null, 'The model request timed out.')
      }
      move('failed')
      return outcome('failed', null, 'The model provider could not be reached.')
    }
    if (options.signal.aborted) {
      throw abortError()
    }
    if (turn.kind === 'incomplete') {
      move('failed')
      const reason = turn.reason === 'max_output_tokens' ? 'The model output budget was exhausted.' : 'The model response was incomplete.'
      return outcome('failed', redactSensitive(turn.text, options.secret), reason)
    }
    if (turn.kind === 'failed') {
      move('failed')
      return outcome('failed', null, redactSensitive(turn.message, options.secret))
    }
    usage = addUsage(usage, turn.usage)
    const actionable = turn.calls.filter((call) => call.name !== 'submit_result')
    const finish = turn.calls.find((call) => call.name === 'submit_result')
    if (actionable.length === 0 && finish) {
      const completion = parseCompletion(finish.arguments)
      if (!completion.ok) {
        input = [
          ...input,
          ...turn.output,
          {
            type: 'function_call_output',
            call_id: finish.callId,
            output: JSON.stringify({ ok: false, outcome: 'rejected', error: completion.error })
          }
        ]
        continue
      }
      const resolved = resolveClaimedCompletion(completion.value, currentSnapshot())
      move(resolved.status)
      return outcome(resolved.status, resolved.summary, resolved.error)
    }
    if (actionable.length === 0) {
      emptyTurns += 1
      stagnantTurns += 1
      if (emptyTurns > AGENT_LIMITS.maxEmptyModelTurns) {
        return stopFromLimit('The model stopped making progress without submitting a result.')
      }
      input = [
        ...input,
        ...turn.output,
        userItem(
          stagnantTurns >= AGENT_LIMITS.maxEmptyModelTurns
            ? 'No tool progress was recorded. Call workspace tools or submit_result with an honest completed, partially_completed, or blocked outcome.'
            : 'Plain text does not finish the mission. Call submit_result or a workspace tool.'
        )
      ]
      continue
    }
    emptyTurns = 0
    move('executing')
    const outputs: unknown[] = []
    const readCache: ReadCache = { files: new Map() }
    const pendingIds: string[] = []
    const pendingCalls: FunctionCall[] = []
    let progressed = false
    let novelThisTurn = false
    for (const call of turn.calls) {
      if (options.signal.aborted) {
        throw abortError()
      }
      toolCalls += 1
      if (toolCalls > AGENT_LIMITS.maxToolCalls) {
        return stopFromLimit('Mission tool-call limit reached')
      }
      const isReadOnly = INSPECTION_TOOLS.has(call.name)
      if (isReadOnly && readOnlyCalls >= AGENT_LIMITS.maxReadOnlyToolCalls) {
        return stopFromLimit('Read-only exploration budget exhausted. Propose an action or ask a clarifying question.')
      }
      if (!isReadOnly && call.name !== 'submit_result' && productiveCalls >= AGENT_LIMITS.maxProductiveToolCalls) {
        return stopFromLimit('Productive action budget exhausted.')
      }
      if (call.name === 'submit_result') {
        const deferred: ToolExecution = {
          state: 'rejected',
          output: JSON.stringify({
            ok: false,
            outcome: 'rejected',
            error: 'Call submit_result after the other tool results, not in the same turn.'
          })
        }
        options.onTool(call, deferred)
        outputs.push({ type: 'function_call_output', call_id: call.callId, output: deferred.output })
        continue
      }

      const fingerprint = toolFingerprint(call.name, call.arguments)
      const prior = seenFingerprints.get(fingerprint)
      if (prior && prior.count >= AGENT_LIMITS.maxIdenticalToolRepeats) {
        const repeated: ToolExecution = {
          state: 'rejected',
          output: JSON.stringify({
            ok: false,
            outcome: 'rejected',
            error: INSPECTION_TOOLS.has(call.name)
              ? `Identical ${call.name} already ran with the same arguments. Do not re-inspect unchanged results. Take a different action, run a command, or call submit_result.`
              : 'Identical tool call already executed without a changed argument set. Do not repeat it. Use a different path/action or call submit_result.',
            priorOutput: prior.lastOutput.slice(0, 1_500)
          })
        }
        options.onTool(call, repeated)
        rememberProblem(repeated.state, repeated.output)
        novelThisTurn = false
        novelFailures += 1
        outputs.push({ type: 'function_call_output', call_id: call.callId, output: repeated.output })
        continue
      }

      if (call.name === 'run_command') {
        const preview = commandPreview(call.arguments)
        if (!options.runCommand) {
          const unavailable: ToolExecution = {
            state: 'rejected',
            output: JSON.stringify({ ok: false, outcome: 'rejected', error: 'Command execution is not available.' })
          }
          options.onTool(call, unavailable)
          outputs.push({ type: 'function_call_output', call_id: call.callId, output: unavailable.output })
          continue
        }
        options.onTool(call, {
          state: 'running',
          output: JSON.stringify({
            ok: true,
            outcome: 'running',
            status: 'running',
            command: preview.command,
            args: preview.args,
            workingDirectory: preview.workingDirectory
          })
        })
        const execution = await options.runCommand(call)
        const redacted = { ...execution, output: redactSensitive(execution.output, options.secret) }
        options.onTool(call, redacted)
        seenFingerprints.set(fingerprint, {
          count: (prior?.count ?? 0) + 1,
          lastOutput: redacted.output
        })
        rememberProblem(redacted.state, redacted.output)
        const payload = parseToolPayload(redacted.output)
        const label = [preview.command, ...preview.args].join(' ')
        const stderr = typeof payload.stderr === 'string' ? payload.stderr : ''
        const error = typeof payload.error === 'string' ? payload.error : null
        const seq = nextSequence()
        const executed = Object.prototype.hasOwnProperty.call(payload, 'exitCode')
        if (!executed) {
          const kind = isArgumentError(redacted.output) ? 'invalid_call' : 'rejected_by_policy'
          if (kind === 'invalid_call') {
            invalidCalls += 1
            consecutiveArgumentErrors += 1
          }
          commandRecords.push({
            label,
            status: kind,
            kind,
            sequence: seq,
            detail: error ?? undefined
          })
        } else {
          const commandStatus = typeof payload.status === 'string' ? payload.status : redacted.state
          const hints =
            commandStatus === 'completed' ? {} : commandFailureHints(label, stderr, error)
          commandRecords.push({
            label,
            status: commandStatus,
            kind: 'executed',
            sequence: seq,
            exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
            cwd:
              typeof payload.workingDirectory === 'string'
                ? payload.workingDirectory
                : preview.workingDirectory,
            ...hints
          })
          consecutiveArgumentErrors = 0
        }
        if (!prior && redacted.state !== 'success') {
          novelThisTurn = true
          novelFailures += 1
        }
        consecutiveReadOnly = 0
        productiveCalls += 1
        if (redacted.state === 'success') {
          progressed = true
          invalidateInspectionFingerprints(seenFingerprints)
          if (readCache) {
            readCache.files.clear()
          }
        }
        outputs.push({ type: 'function_call_output', call_id: call.callId, output: redacted.output })
        continue
      }

      if (isMutationTool(call.name)) {
        const proposed = options.proposeMutation(call)
        const redacted = { ...proposed.execution, output: redactSensitive(proposed.execution.output, options.secret) }
        const pending = proposed.operationId !== null
        options.onTool(
          call,
          pending
            ? {
                state: 'awaiting_approval',
                output: redacted.output
              }
            : redacted
        )
        seenFingerprints.set(fingerprint, {
          count: (prior?.count ?? 0) + 1,
          lastOutput: redacted.output
        })
        rememberProblem(redacted.state, redacted.output)
        const mutationSeq = nextSequence()
        if (redacted.state === 'success') {
          lastMutationSequence = mutationSeq
        }
        if (!prior && redacted.state !== 'success') {
          novelThisTurn = true
          novelFailures += 1
        }
        consecutiveReadOnly = 0
        productiveCalls += 1
        if (isArgumentError(redacted.output)) {
          consecutiveArgumentErrors += 1
        } else {
          consecutiveArgumentErrors = 0
        }
        if (proposed.operationId) {
          pendingIds.push(proposed.operationId)
          pendingCalls.push(call)
          progressed = true
        } else if (redacted.state === 'success') {
          progressed = true
          invalidateInspectionFingerprints(seenFingerprints)
          if (readCache) {
            readCache.files.clear()
          }
          outputs.push({ type: 'function_call_output', call_id: call.callId, output: redacted.output })
        } else {
          outputs.push({ type: 'function_call_output', call_id: call.callId, output: redacted.output })
        }
        continue
      }

      const execution = options.executeTool(call.name, call.arguments, readCache)
      const redacted = { ...execution, output: redactSensitive(execution.output, options.secret) }
      options.onTool(call, redacted)
      seenFingerprints.set(fingerprint, {
        count: (prior?.count ?? 0) + 1,
        lastOutput: redacted.output
      })
      readOnlyCalls += 1
      consecutiveReadOnly += 1
      recordExplored(call.name, call.arguments, redacted.output)
      const payload = parseToolPayload(redacted.output)
      if (call.name === 'read_file' && payload.ok === true && typeof payload.path === 'string') {
        verifiedReads.add(payload.path)
      }
      rememberProblem(redacted.state, redacted.output)
      if (isArgumentError(redacted.output)) {
        consecutiveArgumentErrors += 1
        if (consecutiveArgumentErrors > AGENT_LIMITS.maxConsecutiveArgumentErrors) {
          return stopFromLimit('Too many consecutive invalid tool-argument errors.')
        }
      } else {
        consecutiveArgumentErrors = 0
      }
      if (redacted.state === 'success') {
        progressed = true
      } else if (!prior) {
        novelThisTurn = true
        novelFailures += 1
      }
      outputs.push({ type: 'function_call_output', call_id: call.callId, output: redacted.output })
    }
    if (pendingIds.length > 0) {
      move('awaiting_approval')
      const resolved = await options.waitForApprovals(pendingIds)
      if (options.signal.aborted) {
        throw abortError()
      }
      move('verifying')
      for (const item of resolved) {
        const call = pendingCalls.find((entry) => entry.callId === item.callId)
        if (call) {
          options.onTool(call, { ...item.execution, output: redactSensitive(item.execution.output, options.secret) })
        }
        const payload = parseToolPayload(item.execution.output)
        if (payload.applied === true && typeof payload.path === 'string') {
          progressed = true
          invalidateInspectionFingerprints(seenFingerprints)
          if (readCache) {
            readCache.files.clear()
          }
        }
        outputs.push({
          type: 'function_call_output',
          call_id: item.callId,
          output: redactSensitive(item.execution.output, options.secret)
        })
      }
    }
    if (novelFailures > AGENT_LIMITS.maxNovelFailures) {
      return stopFromLimit('Repeated tool failures made no meaningful progress.')
    }
    if (consecutiveArgumentErrors > AGENT_LIMITS.maxConsecutiveArgumentErrors) {
      return stopFromLimit('Too many consecutive invalid tool-argument errors.')
    }
    if (
      consecutiveReadOnly >= AGENT_LIMITS.maxConsecutiveReadOnlyWithoutAction &&
      productiveCalls === 0
    ) {
      const known = [...exploredPaths].slice(0, 40).join(', ') || '(none yet)'
      if (!explorationWarned) {
        explorationWarned = true
        outputs.push(
          userItem(
            `Exploration without action: ${consecutiveReadOnly} consecutive read-only calls and no mutation/command yet. Paths already seen: ${known}. Next action MUST be a delete/create/edit proposal, a run_command, or a clarifying question — not another list_files of a sibling directory. Prefer list_files with recursive:true once if you still need the tree.`
          )
        )
      } else if (
        consecutiveReadOnly >=
        AGENT_LIMITS.maxConsecutiveReadOnlyWithoutAction + AGENT_LIMITS.maxExplorationGraceIterations
      ) {
        return stopFromLimit('exploration without action')
      }
    }
    if (readOnlyCalls >= AGENT_LIMITS.maxReadOnlyToolCalls - 2 && productiveCalls === 0) {
      outputs.push(
        userItem(
          `Read-only budget nearly exhausted (${readOnlyCalls}/${AGENT_LIMITS.maxReadOnlyToolCalls}). Act on what you have: propose the change, run a command, or ask the user a clarifying question.`
        )
      )
    }
    if (!progressed) {
      // A new rejection is delivered so the model can correct it. Only empty turns
      // and repeats of a call that already ran consume the stagnation budget.
      if (!novelThisTurn) {
        stagnantTurns += 1
        if (stagnantTurns > AGENT_LIMITS.maxEmptyModelTurns) {
          return stopFromLimit('Repeated tool attempts made no meaningful progress.')
        }
      }
      const hint =
        lastProblem && /unrecognized key|expected string|arguments were rejected/i.test(lastProblem)
          ? '\nCorrect the tool argument schema using the error example before retrying.'
          : '\nDo not re-list the same paths. Diagnose the last error, take a different action, or call submit_result.'
      outputs.push(
        userItem(
          `No meaningful progress was recorded. Current execution record:\n${compactLedger(currentSnapshot())}${hint}`
        )
      )
    } else {
      stagnantTurns = 0
      novelFailures = 0
    }
    input = [...input, ...turn.output, ...outputs]
    move('analyzing')
  }
  return stopFromLimit('Mission iteration limit reached')
}
