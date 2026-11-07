import { AGENT_LIMITS, redactSensitive } from '../../shared/agent.ts'
import type { ConnectionState } from '../../shared/provider.ts'

export const BHARATCODE_BASE_URL = 'https://bharatcode.ai/api/model/v1'
export const BHARATCODE_MODEL = 'qwen-3.8-27b'

export type FunctionCall = {
  callId: string
  name: string
  arguments: string
}

export type TokenUsageReport = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type ProviderFailureCode = 'authentication' | 'usage' | 'unavailable' | 'unsupported' | 'malformed'

export type ProviderTurn =
  | { kind: 'completed'; output: unknown[]; calls: FunctionCall[]; text: string; requestId: string | null; usage?: TokenUsageReport }
  | { kind: 'incomplete'; reason: string; text: string; requestId: string | null }
  | { kind: 'failed'; message: string; requestId: string | null; code?: ProviderFailureCode }

export function addUsage(current: TokenUsageReport | undefined, next: TokenUsageReport | undefined): TokenUsageReport | undefined {
  if (!next) {
    return current
  }
  if (!current) {
    return next
  }
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens: current.totalTokens + next.totalTokens
  }
}

export type SseEvent = { event: string; data: string }

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export function drainSse(buffer: string): { events: SseEvent[]; rest: string } {
  const parts = buffer.split(/\n\n/)
  const rest = parts.pop() ?? ''
  const events: SseEvent[] = []
  for (const part of parts) {
    if (!part.trim()) {
      continue
    }
    let eventName = 'message'
    const dataLines: string[] = []
    for (const rawLine of part.split(/\n/)) {
      const line = rawLine.replace(/\r$/, '')
      if (line.startsWith(':')) {
        continue
      }
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
    if (dataLines.length > 0) {
      events.push({ event: eventName, data: dataLines.join('\n') })
    }
  }
  return { events, rest }
}

function requestIdOf(response: Response): string | null {
  return response.headers.get('x-request-id')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function textFromOutput(output: unknown[]): string {
  const parts: string[] = []
  for (const item of output) {
    const record = asRecord(item)
    if (!record || record.type !== 'message' || !Array.isArray(record.content)) {
      continue
    }
    for (const part of record.content) {
      const piece = asRecord(part)
      if (piece?.type === 'output_text' && typeof piece.text === 'string') {
        parts.push(piece.text)
      }
    }
  }
  return parts.join('')
}

function callsFromOutput(output: unknown[]): FunctionCall[] | null {
  const calls: FunctionCall[] = []
  for (const item of output) {
    const record = asRecord(item)
    if (!record || record.type !== 'function_call') {
      continue
    }
    if (typeof record.call_id !== 'string' || typeof record.name !== 'string' || typeof record.arguments !== 'string') {
      return null
    }
    calls.push({ callId: record.call_id, name: record.name, arguments: record.arguments })
  }
  return calls
}

function failureMessage(body: unknown, fallback: string, secret: string): string {
  const record = asRecord(body)
  const error = asRecord(record?.error)
  const message = typeof error?.message === 'string' ? error.message : fallback
  return redactSensitive(message, secret).slice(0, 500)
}

export function turnFromResponse(body: unknown, accumulatedText: string, requestId: string | null, secret: string): ProviderTurn {
  const record = asRecord(body)
  if (!record) {
    return { kind: 'failed', message: 'The model response was malformed.', requestId }
  }
  const status = typeof record.status === 'string' ? record.status : ''
  const output = Array.isArray(record.output) ? record.output : []
  const text = textFromOutput(output) || accumulatedText
  if (status === 'failed') {
    return { kind: 'failed', message: failureMessage(record, 'The model request failed.', secret), requestId }
  }
  if (status === 'incomplete') {
    const details = asRecord(record.incomplete_details)
    const reason = typeof details?.reason === 'string' ? details.reason : 'incomplete'
    return { kind: 'incomplete', reason, text, requestId }
  }
  if (status !== 'completed') {
    return { kind: 'failed', message: 'The model response was malformed.', requestId }
  }
  const calls = callsFromOutput(output)
  if (!calls) {
    return { kind: 'incomplete', reason: 'malformed_function_call', text, requestId }
  }
  return { kind: 'completed', output, calls, text, requestId }
}

function applyEvent(event: SseEvent, accumulated: string, requestId: string | null, secret: string, onDelta?: (delta: string) => void): { text: string; turn: ProviderTurn | null } {
  let payload: unknown
  try {
    payload = JSON.parse(event.data)
  } catch {
    return { text: accumulated, turn: null }
  }
  const record = asRecord(payload)
  if (!record) {
    return { text: accumulated, turn: null }
  }
  const type = typeof record.type === 'string' ? record.type : event.event
  if (type === 'response.output_text.delta' && typeof record.delta === 'string') {
    onDelta?.(record.delta)
    return { text: accumulated + record.delta, turn: null }
  }
  if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
    const response = record.response ?? record
    const forced = type === 'response.incomplete' ? { ...(asRecord(response) ?? {}), status: 'incomplete' } : response
    const failed = type === 'response.failed' ? { ...(asRecord(response) ?? {}), status: 'failed' } : forced
    return { text: accumulated, turn: turnFromResponse(type === 'response.completed' ? response : failed, accumulated, requestId, secret) }
  }
  return { text: accumulated, turn: null }
}

async function readStream(response: Response, secret: string, onDelta?: (delta: string) => void): Promise<ProviderTurn> {
  const requestId = requestIdOf(response)
  const reader = response.body?.getReader()
  if (!reader) {
    return { kind: 'failed', message: 'The model response had no body.', requestId }
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let finished: ProviderTurn | null = null
  while (!finished) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    buffer += decoder.decode(chunk.value, { stream: true })
    const drained = drainSse(buffer)
    buffer = drained.rest
    for (const event of drained.events) {
      const applied = applyEvent(event, text, requestId, secret, onDelta)
      text = applied.text
      if (text.length > AGENT_LIMITS.maxStoredTextChars) {
        await reader.cancel()
        return { kind: 'incomplete', reason: 'output_limit', text: text.slice(0, AGENT_LIMITS.maxStoredTextChars), requestId }
      }
      if (applied.turn) {
        finished = applied.turn
        break
      }
    }
  }
  await reader.cancel().catch(() => undefined)
  return finished ?? { kind: 'failed', message: 'The model stream ended without a completion event.', requestId }
}

function abortError(): Error {
  const error = new Error('The model request was cancelled.')
  error.name = 'AbortError'
  return error
}

async function pause(ms: number, signal: AbortSignal, sleep: (delay: number) => Promise<void>): Promise<void> {
  if (signal.aborted) {
    throw abortError()
  }
  await sleep(ms)
  if (signal.aborted) {
    throw abortError()
  }
}

export async function requestBharatCode(options: {
  apiKey: string
  instructions: string
  input: unknown[]
  tools: unknown[]
  signal: AbortSignal
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  onDelta?: (delta: string) => void
}): Promise<ProviderTurn> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const body = JSON.stringify({
    model: BHARATCODE_MODEL,
    store: false,
    stream: true,
    max_output_tokens: AGENT_LIMITS.maxOutputTokens,
    reasoning: { effort: 'none' },
    instructions: options.instructions,
    input: options.input,
    tools: options.tools,
    tool_choice: 'auto'
  })
  let serviceAttempts = 0
  let rateAttempts = 0
  while (true) {
    let response: Response
    try {
      response = await fetchImpl(`${BHARATCODE_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body,
        signal: options.signal
      })
    } catch (error) {
      if (options.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw abortError()
      }
      return { kind: 'failed', code: 'unavailable', message: 'The model provider could not be reached.', requestId: null }
    }
    const requestId = requestIdOf(response)
    if (response.status === 401) {
      return {
        kind: 'failed',
        code: 'authentication',
        message: `BharatCode rejected the API key.${requestId ? ` Request ${requestId}.` : ''}`,
        requestId
      }
    }
    if (response.status === 402) {
      let payload: unknown = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      return {
        kind: 'failed',
        code: 'usage',
        message: failureMessage(payload, 'BharatCode rejected the request because the account cannot use the API.', options.apiKey),
        requestId
      }
    }
    if (response.status === 429 && rateAttempts < 1) {
      rateAttempts += 1
      const retryAfter = Number(response.headers.get('retry-after'))
      const delay = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 0) * 1000, 2_000) : 1_000
      await response.body?.cancel().catch(() => undefined)
      await pause(delay, options.signal, sleep)
      continue
    }
    if (response.status === 503 && serviceAttempts < AGENT_LIMITS.serviceRetries) {
      serviceAttempts += 1
      await response.body?.cancel().catch(() => undefined)
      await pause(1_000 * serviceAttempts, options.signal, sleep)
      continue
    }
    if (response.status === 429) {
      return { kind: 'failed', code: 'usage', message: `BharatCode rate limit.${requestId ? ` Request ${requestId}.` : ''}`, requestId }
    }
    if (response.status === 503) {
      return { kind: 'failed', code: 'unavailable', message: `BharatCode is busy.${requestId ? ` Request ${requestId}.` : ''}`, requestId }
    }
    if (!response.ok) {
      let payload: unknown = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      return {
        kind: 'failed',
        message: failureMessage(payload, `The model request failed (${response.status}).`, options.apiKey),
        requestId
      }
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        return { kind: 'failed', message: 'The model response was malformed.', requestId }
      }
      return turnFromResponse(payload, '', requestId, options.apiKey)
    }
    return readStream(response, options.apiKey, options.onDelta)
  }
}

export async function probeBharatCode(apiKey: string, fetchImpl: FetchLike = fetch): Promise<ConnectionState> {
  try {
    const response = await fetchImpl(`${BHARATCODE_BASE_URL}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        model: BHARATCODE_MODEL,
        store: false,
        stream: false,
        max_output_tokens: 16,
        reasoning: { effort: 'none' },
        input: [{ role: 'user', content: 'Reply with the single word pong.' }]
      })
    })
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401) {
      return 'authentication_failed'
    }
    if (response.status === 402 || response.status === 429) {
      return 'usage_restricted'
    }
    return response.ok ? 'verified' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
