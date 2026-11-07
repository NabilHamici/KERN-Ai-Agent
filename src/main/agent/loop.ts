import {
  AGENT_LIMITS,
  assertTransition,
  isMutationTool,
  redactSensitive,
  type MissionStatus
} from '../../shared/agent.ts'
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
    `You are KERN, a controlled coding assistant for the workspace "${workspaceName}".`,
    'You may list, read, and search files with the provided tools. Paths are relative to the workspace.',
    'To change files, call create_file, edit_file, delete_file, or rename_file. Those tools only create proposals.',
    'Never claim a change was applied until a tool result says applied:true after user approval.',
    'If a proposal is rejected, cancelled, or stale, do not retry the identical proposal. Propose a revised change or call submit_result.',
    'After an approved apply, read the file again to verify the result before finishing.',
    'You cannot run shell commands or use Git.',
    'Do not invent file contents.',
    'Plain text does not finish the mission. Call submit_result with outcome "completed" or "blocked" and a summary when you are done.'
  ].join(' ')
}

function userItem(text: string): { role: 'user'; content: string } {
  return { role: 'user', content: text }
}

export async function runAgentLoop(options: {
  prompt: string
  workspaceName: string
  signal: AbortSignal
  secret: string
  client: ModelClient
  executeTool: (name: string, argumentsText: string, cache?: ReadCache) => ToolExecution
  proposeMutation: (call: FunctionCall) => {
    execution: ToolExecution
    operationId: string | null
  }
  waitForApprovals: (operationIds: string[]) => Promise<Array<{ callId: string; execution: ToolExecution }>>
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
  let input: unknown[] = [userItem(options.prompt)]
  let toolCalls = 0
  let usage: TokenUsageReport | undefined
  const outcome = (next: MissionStatus, summary: string | null, error: string | null): LoopResult => ({
    status: next,
    summary,
    error,
    usage
  })
  for (let iteration = 0; iteration < AGENT_LIMITS.maxIterations; iteration += 1) {
    if (options.signal.aborted) {
      throw abortError()
    }
    const requestSignal = AbortSignal.any([options.signal, AbortSignal.timeout(AGENT_LIMITS.requestTimeoutMs)])
    if (JSON.stringify(input).length + instructions.length > AGENT_LIMITS.maxContextChars) {
      move('failed')
      return outcome('failed', null, 'Mission context limit reached')
    }
    let turn: ProviderTurn
    try {
      turn = await options.client({
        instructions,
        input,
        tools: [...MODEL_TOOLS],
        signal: requestSignal,
        onDelta: (delta) => options.onText(redactSensitive(delta, options.secret))
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
      if (!completion) {
        input = [
          ...input,
          ...turn.output,
          { type: 'function_call_output', call_id: finish.callId, output: JSON.stringify({ ok: false, error: 'Completion arguments were rejected.' }) }
        ]
        continue
      }
      move(completion.outcome === 'completed' ? 'completed' : 'failed')
      return outcome(
        completion.outcome === 'completed' ? 'completed' : 'failed',
        completion.summary,
        completion.outcome === 'blocked' ? completion.summary : null
      )
    }
    if (actionable.length === 0) {
      input = [
        ...input,
        ...turn.output,
        userItem('Plain text does not finish the mission. Call submit_result or a workspace tool.')
      ]
      continue
    }
    move('executing')
    const outputs: unknown[] = []
    const readCache: ReadCache = { files: new Map() }
    const pendingIds: string[] = []
    const pendingCalls: FunctionCall[] = []
    for (const call of turn.calls) {
      if (options.signal.aborted) {
        throw abortError()
      }
      toolCalls += 1
      if (toolCalls > AGENT_LIMITS.maxToolCalls) {
        move('failed')
        return outcome('failed', null, 'Mission tool-call limit reached')
      }
      if (call.name === 'submit_result') {
        const deferred: ToolExecution = {
          state: 'rejected',
          output: JSON.stringify({ ok: false, error: 'Call submit_result after the other tool results, not in the same turn.' })
        }
        options.onTool(call, deferred)
        outputs.push({ type: 'function_call_output', call_id: call.callId, output: deferred.output })
        continue
      }
      if (isMutationTool(call.name)) {
        const proposed = options.proposeMutation(call)
        const redacted = { ...proposed.execution, output: redactSensitive(proposed.execution.output, options.secret) }
        options.onTool(call, redacted.state === 'rejected' ? redacted : { state: 'started', output: redacted.output })
        if (proposed.operationId) {
          pendingIds.push(proposed.operationId)
          pendingCalls.push(call)
        } else {
          outputs.push({ type: 'function_call_output', call_id: call.callId, output: redacted.output })
        }
        continue
      }
      const execution = options.executeTool(call.name, call.arguments, readCache)
      options.onTool(call, { ...execution, output: redactSensitive(execution.output, options.secret) })
      outputs.push({ type: 'function_call_output', call_id: call.callId, output: redactSensitive(execution.output, options.secret) })
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
        outputs.push({
          type: 'function_call_output',
          call_id: item.callId,
          output: redactSensitive(item.execution.output, options.secret)
        })
      }
    }
    input = [...input, ...turn.output, ...outputs]
    move('analyzing')
  }
  move('failed')
  return outcome('failed', null, 'Mission iteration limit reached')
}
