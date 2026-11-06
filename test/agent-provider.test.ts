import assert from 'node:assert/strict'
import test from 'node:test'
import { BHARATCODE_BASE_URL, BHARATCODE_MODEL, requestBharatCode, turnFromResponse } from '../src/main/agent/provider.ts'

const secret = 'bc_live_test_key_value'

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-json', ...headers }
  })
}

function sseResponse(frames: string[], status = 200): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.join('')))
      controller.close()
    }
  })
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-stream' }
  })
}

function frame(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`
}

test('parses a completed response and a function call', () => {
  const turn = turnFromResponse(
    {
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking' }] },
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"note.txt"}' }
      ]
    },
    '',
    'req-1',
    secret
  )
  assert.equal(turn.kind, 'completed')
  if (turn.kind === 'completed') {
    assert.equal(turn.text, 'Looking')
    assert.equal(turn.calls.length, 1)
    assert.equal(turn.calls[0]?.name, 'read_file')
    assert.equal(turn.requestId, 'req-1')
  }
})

test('treats a malformed function call as incomplete and does not return calls', () => {
  const turn = turnFromResponse(
    {
      status: 'completed',
      output: [{ type: 'function_call', name: 'read_file' }]
    },
    '',
    'req-bad',
    secret
  )
  assert.equal(turn.kind, 'incomplete')
  if (turn.kind === 'incomplete') {
    assert.equal(turn.reason, 'malformed_function_call')
    assert.equal('calls' in turn, false)
  }
})

test('keeps an exhausted output budget incomplete', () => {
  const turn = turnFromResponse(
    {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"note.txt"}' }]
    },
    'partial',
    'req-cap',
    secret
  )
  assert.equal(turn.kind, 'incomplete')
  if (turn.kind === 'incomplete') {
    assert.equal(turn.reason, 'max_output_tokens')
  }
})

test('streams text deltas and extracts the function call', async () => {
  const deltas: string[] = []
  const turn = await requestBharatCode({
    apiKey: secret,
    instructions: 'inspect',
    input: [],
    tools: [],
    signal: new AbortController().signal,
    sleep: async () => undefined,
    onDelta: (delta) => deltas.push(delta),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      assert.equal(body.model, BHARATCODE_MODEL)
      assert.equal(body.store, false)
      assert.equal(body.stream, true)
      assert.equal('previous_response_id' in body, false)
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), `Bearer ${secret}`)
      return sseResponse([
        ': keepalive\n\n',
        frame({ type: 'response.output_text.delta', delta: 'Hel' }),
        frame({ type: 'response.output_text.delta', delta: 'lo' }),
        frame({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
              { type: 'function_call', call_id: 'call_9', name: 'list_files', arguments: '{"path":"."}' }
            ]
          }
        })
      ])
    }
  })
  assert.deepEqual(deltas, ['Hel', 'lo'])
  assert.equal(turn.kind, 'completed')
  if (turn.kind === 'completed') {
    assert.equal(turn.calls[0]?.callId, 'call_9')
    assert.equal(turn.requestId, 'req-stream')
    assert.equal(JSON.stringify(turn).includes(secret), false)
  }
})

test('reports authentication failure without the API key', async () => {
  const turn = await requestBharatCode({
    apiKey: secret,
    instructions: 'inspect',
    input: [],
    tools: [],
    signal: new AbortController().signal,
    sleep: async () => undefined,
    fetchImpl: async () => jsonResponse({ error: { message: `bad ${secret}` } }, 401, { 'x-request-id': 'req-401' })
  })
  assert.equal(turn.kind, 'failed')
  if (turn.kind === 'failed') {
    assert.match(turn.message, /rejected the API key/)
    assert.match(turn.message, /req-401/)
    assert.equal(turn.message.includes(secret), false)
  }
})

test('retries a capacity error with bounded backoff', async () => {
  const waits: number[] = []
  let attempts = 0
  const turn = await requestBharatCode({
    apiKey: secret,
    instructions: 'inspect',
    input: [],
    tools: [],
    signal: new AbortController().signal,
    sleep: async (ms) => {
      waits.push(ms)
    },
    fetchImpl: async (url) => {
      assert.equal(url, `${BHARATCODE_BASE_URL}/responses`)
      attempts += 1
      if (attempts < 3) {
        return jsonResponse({}, 503, { 'x-request-id': 'req-503' })
      }
      return jsonResponse({
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ready' }] }]
      })
    }
  })
  assert.deepEqual(waits, [1000, 2000])
  assert.equal(attempts, 3)
  assert.equal(turn.kind, 'completed')
})

test('does not retry after the capacity budget is spent', async () => {
  let attempts = 0
  const turn = await requestBharatCode({
    apiKey: secret,
    instructions: 'inspect',
    input: [],
    tools: [],
    signal: new AbortController().signal,
    sleep: async () => undefined,
    fetchImpl: async () => {
      attempts += 1
      return jsonResponse({}, 503)
    }
  })
  assert.equal(attempts, 3)
  assert.equal(turn.kind, 'failed')
  if (turn.kind === 'failed') {
    assert.match(turn.message, /busy/)
    assert.equal(turn.message.includes(secret), false)
  }
})

test('cancels an in-flight request', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () =>
      requestBharatCode({
        apiKey: secret,
        instructions: 'inspect',
        input: [],
        tools: [],
        signal: controller.signal,
        sleep: async () => undefined,
        fetchImpl: async () => {
          throw abortError()
        }
      }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
})
