import {
  AGENT_LIMITS,
  assertTransition,
  redactSensitive,
  type MissionStatus
} from '../../shared/agent.ts'
import { MODEL_TOOLS, parseCompletion, type ToolExecution } from './tools.ts'
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
    `You are KERN, a read-only assistant for the workspace "${workspaceName}".`,
    'You may list, read, and search files with the provided tools. Paths are relative to the workspace.',
    'You cannot create, edit, delete, rename, run commands, or use Git.',
    'Do not invent file contents. Do not claim a change was made.',
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
  executeTool: (name: string, argumentsText: string) => ToolExecution
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
    const reads = turn.calls.filter((call) => call.name !== 'submit_result')
    const finish = turn.calls.find((call) => call.name === 'submit_result')
    if (reads.length === 0 && finish) {
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
    if (reads.length === 0) {
      input = [
        ...input,
        ...turn.output,
        userItem('Plain text does not finish the mission. Call submit_result or a read-only tool.')
      ]
      continue
    }
    move('executing')
    const outputs: unknown[] = []
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
      const execution = options.executeTool(call.name, call.arguments)
      options.onTool(call, { ...execution, output: redactSensitive(execution.output, options.secret) })
      outputs.push({ type: 'function_call_output', call_id: call.callId, output: redactSensitive(execution.output, options.secret) })
    }
    input = [...input, ...turn.output, ...outputs]
    move('analyzing')
  }
  move('failed')
  return outcome('failed', null, 'Mission iteration limit reached')
}
