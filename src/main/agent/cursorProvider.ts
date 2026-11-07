import { redactSensitive } from '../../shared/agent.ts'
import { CURSOR_INCLUDED_MODEL } from '../../shared/provider.ts'
import type { FunctionCall, ProviderFailureCode, ProviderTurn, TokenUsageReport } from './provider.ts'

export const KERN_TOOL_NAMES = ['list_files', 'read_file', 'search_files', 'get_workspace_info', 'submit_result'] as const

const ALLOWED = new Set<string>(KERN_TOOL_NAMES)

export type CursorToolProposal = {
  callId: string
  name: string
  arguments: unknown
}

export type CursorBridgeResult = {
  status: 'finished' | 'cancelled' | 'error'
  text: string
  requestId: string | null
  usage?: TokenUsageReport
  errorMessage?: string
  errorName?: string
  errorStatus?: number
}

export type CursorBridge = {
  run(input: {
    apiKey: string
    prompt: string
    signal: AbortSignal
    onDelta: (delta: string) => void
    handleTool: (proposal: CursorToolProposal) => void
    handleForeignTool: (name: string) => void
  }): Promise<CursorBridgeResult>
}

function abortError(): Error {
  const error = new Error('The model request was cancelled.')
  error.name = 'AbortError'
  return error
}

function historyText(input: unknown[]): string {
  return input
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return JSON.stringify(item)
      }
      const record = item as Record<string, unknown>
      if (typeof record.role === 'string' && typeof record.content === 'string') {
        return `${record.role}: ${record.content}`
      }
      return JSON.stringify(record)
    })
    .join('\n\n')
}

function argumentsText(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function failureCode(name: string | undefined, status: number | undefined): ProviderFailureCode {
  if (name === 'AuthenticationError' || status === 401) {
    return 'authentication'
  }
  if (name === 'RateLimitError' || status === 402 || status === 429) {
    return 'usage'
  }
  return 'unavailable'
}

function failureMessage(code: ProviderFailureCode, secret: string, raw: string | undefined): string {
  if (code === 'authentication') {
    return 'Cursor could not use the saved login on this Mac.'
  }
  if (code === 'usage') {
    return 'Cursor usage is restricted for this account. KERN only uses Composer 2.5 from the included plan pool.'
  }
  const message = raw ? redactSensitive(raw, secret).slice(0, 500) : ''
  if (code === 'unsupported') {
    return 'Cursor proposed a tool KERN does not run.'
  }
  return message || 'The Cursor provider could not be reached.'
}

export function assertCursorModel(id: string): void {
  if (id !== CURSOR_INCLUDED_MODEL) {
    throw new Error('KERN only sends Composer 2.5, which stays on the included Cursor plan pool.')
  }
}

export async function requestCursor(options: {
  apiKey: string
  instructions: string
  input: unknown[]
  signal: AbortSignal
  onDelta?: (delta: string) => void
  bridge: CursorBridge
}): Promise<ProviderTurn> {
  assertCursorModel(CURSOR_INCLUDED_MODEL)
  if (options.signal.aborted) {
    throw abortError()
  }
  const calls: FunctionCall[] = []
  let malformed = false
  let foreign: string | null = null
  const prompt = `${options.instructions}\n\n${historyText(options.input)}`
  let result: CursorBridgeResult
  try {
    result = await options.bridge.run({
      apiKey: options.apiKey,
      prompt,
      signal: options.signal,
      onDelta: (delta) => options.onDelta?.(delta),
      handleTool: (proposal) => {
        const encoded = argumentsText(proposal.arguments)
        if (!proposal.callId || !ALLOWED.has(proposal.name) || !encoded) {
          malformed = true
          return
        }
        calls.push({ callId: proposal.callId, name: proposal.name, arguments: encoded })
      },
      handleForeignTool: (name) => {
        foreign = name || 'unknown'
      }
    })
  } catch (error) {
    if (options.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw abortError()
    }
    const name = error instanceof Error ? error.name : undefined
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined
    const code = failureCode(name, status)
    const raw = error instanceof Error ? error.message : undefined
    return { kind: 'failed', code, message: failureMessage(code, options.apiKey, raw), requestId: null }
  }
  if (options.signal.aborted) {
    throw abortError()
  }
  if (foreign) {
    return {
      kind: 'failed',
      code: 'unsupported',
      message: failureMessage('unsupported', options.apiKey, undefined),
      requestId: result.requestId
    }
  }
  if (malformed) {
    return { kind: 'incomplete', reason: 'malformed_function_call', text: result.text, requestId: result.requestId }
  }
  if (result.status === 'error') {
    const code = failureCode(result.errorName, result.errorStatus)
    return {
      kind: 'failed',
      code,
      message: failureMessage(code, options.apiKey, result.errorMessage),
      requestId: result.requestId
    }
  }
  if (result.status === 'cancelled' && calls.length === 0) {
    return { kind: 'failed', code: 'unavailable', message: 'The Cursor run stopped before it returned a result.', requestId: result.requestId }
  }
  return {
    kind: 'completed',
    output: calls.map((call) => ({ type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments })),
    calls,
    text: result.text,
    requestId: result.requestId,
    usage: result.usage
  }
}
