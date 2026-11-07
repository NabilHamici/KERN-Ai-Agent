import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { cursorAgentOptions } from '../src/main/agent/cursorSdk.ts'
import { assertCursorModel, requestCursor, type CursorBridge } from '../src/main/agent/cursorProvider.ts'
import { CURSOR_INCLUDED_MODEL } from '../src/shared/provider.ts'
import { executeTool } from '../src/main/agent/tools.ts'
import { runAgentLoop } from '../src/main/agent/loop.ts'
import { MissionDatabase } from '../src/main/services/database.ts'
import { checkSelectedProvider, providerSnapshot, readProviderId, writeProviderId } from '../src/main/agent/providerSettings.ts'

const secret = 'cursor_test_key_value'

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

test('rejects any Cursor model outside the included pool', () => {
  assert.doesNotThrow(() => assertCursorModel(CURSOR_INCLUDED_MODEL))
  assert.throws(() => assertCursorModel('gpt-5'), /included Cursor plan pool/)
})

test('Cursor agent options disable host tools and pin Composer 2.5', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-cursor-'))
  const options = cursorAgentOptions({
    apiKey: secret,
    stateDir,
    onTool: () => undefined
  })
  assert.equal(options.model && typeof options.model === 'object' ? options.model.id : '', CURSOR_INCLUDED_MODEL)
  assert.deepEqual(options.tools, ['mcp'])
  assert.equal(options.disallowedTools?.includes('shell'), true)
  assert.equal(options.disallowedTools?.includes('edit'), true)
  assert.equal(options.disallowedTools?.includes('delete'), true)
  assert.equal(options.local?.cwd, stateDir)
  assert.deepEqual(options.local?.settingSources, [])
  assert.equal(options.local?.enableAgentRetries, false)
  assert.ok(options.local?.fs)
  const names = Object.keys(options.local?.customTools ?? {}).sort()
  assert.deepEqual(names, [
    'create_file',
    'delete_file',
    'edit_file',
    'get_workspace_info',
    'list_files',
    'read_file',
    'rename_file',
    'search_files',
    'submit_result'
  ])
  const { apiKey, ...rest } = options
  assert.equal(apiKey, secret)
  assert.equal(JSON.stringify(rest).includes(secret), false)
  const storedLogin = cursorAgentOptions({
    stateDir,
    onTool: () => undefined
  })
  assert.equal(storedLogin.apiKey, undefined)
  assert.equal(storedLogin.model && typeof storedLogin.model === 'object' ? storedLogin.model.id : '', CURSOR_INCLUDED_MODEL)
})

test('streams text and normalizes a tool proposal', async () => {
  const deltas: string[] = []
  const bridge: CursorBridge = {
    async run(input) {
      input.onDelta('Looking')
      input.handleTool({ callId: 'call_1', name: 'read_file', arguments: { path: 'note.txt' } })
      return { status: 'cancelled', text: 'Looking', requestId: 'req-cursor', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
    }
  }
  const turn = await requestCursor({
    apiKey: secret,
    instructions: 'inspect',
    input: [{ role: 'user', content: 'Read note.txt' }],
    signal: new AbortController().signal,
    onDelta: (delta) => deltas.push(delta),
    bridge
  })
  assert.deepEqual(deltas, ['Looking'])
  assert.equal(turn.kind, 'completed')
  if (turn.kind === 'completed') {
    assert.equal(turn.calls[0]?.name, 'read_file')
    assert.equal(turn.calls[0]?.arguments, '{"path":"note.txt"}')
    assert.equal(turn.usage?.totalTokens, 5)
    assert.equal(JSON.stringify(turn).includes(secret), false)
  }
})

test('treats a malformed tool proposal as incomplete', async () => {
  const bridge: CursorBridge = {
    async run(input) {
      input.handleTool({ callId: '', name: 'read_file', arguments: { path: 'note.txt' } })
      return { status: 'cancelled', text: '', requestId: null }
    }
  }
  const turn = await requestCursor({
    apiKey: secret,
    instructions: 'inspect',
    input: [],
    signal: new AbortController().signal,
    bridge
  })
  assert.equal(turn.kind, 'incomplete')
  if (turn.kind === 'incomplete') {
    assert.equal(turn.reason, 'malformed_function_call')
  }
})

test('rejects a built-in Cursor tool without returning calls', async () => {
  const bridge: CursorBridge = {
    async run(input) {
      input.handleForeignTool('shell')
      input.handleTool({ callId: 'call_1', name: 'read_file', arguments: { path: 'note.txt' } })
      return { status: 'cancelled', text: '', requestId: 'req-foreign' }
    }
  }
  const turn = await requestCursor({
    apiKey: secret,
    instructions: 'inspect',
    input: [],
    signal: new AbortController().signal,
    bridge
  })
  assert.equal(turn.kind, 'failed')
  if (turn.kind === 'failed') {
    assert.equal(turn.code, 'unsupported')
    assert.equal('calls' in turn, false)
  }
})

test('maps authentication and usage failures without the key', async () => {
  const auth = await requestCursor({
    apiKey: secret,
    instructions: 'inspect',
    input: [],
    signal: new AbortController().signal,
    bridge: {
      run: async () => {
        const error = new Error(`bad ${secret}`)
        error.name = 'AuthenticationError'
        throw error
      }
    }
  })
  assert.equal(auth.kind, 'failed')
  if (auth.kind === 'failed') {
    assert.equal(auth.code, 'authentication')
    assert.equal(auth.message.includes(secret), false)
  }
  const limited = await requestCursor({
    apiKey: secret,
    instructions: 'inspect',
    input: [],
    signal: new AbortController().signal,
    bridge: {
      run: async () => {
        const error = new Error('quota')
        error.name = 'RateLimitError'
        throw error
      }
    }
  })
  assert.equal(limited.kind, 'failed')
  if (limited.kind === 'failed') {
    assert.equal(limited.code, 'usage')
    assert.match(limited.message, /included plan pool/)
  }
})

test('cancels a Cursor request from the abort signal', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () =>
      requestCursor({
        apiKey: secret,
        instructions: 'inspect',
        input: [],
        signal: controller.signal,
        bridge: {
          run: async () => {
            throw abortError()
          }
        }
      }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
})

test('the tool broker still rejects writes when the provider is Cursor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-cursor-broker-'))
  const result = executeTool(root, 'demo', 'write_file', '{"path":"out.txt"}')
  assert.equal(result.state, 'rejected')
  assert.equal(fs.existsSync(path.join(root, 'out.txt')), false)
})

test('a Cursor tool proposal is executed only by the KERN loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-cursor-loop-'))
  fs.writeFileSync(path.join(root, 'note.txt'), 'visible')
  let executed = 0
  let turns = 0
  const result = await runAgentLoop({
    prompt: 'Read note.txt',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret,
    client: async () => {
      turns += 1
      if (turns === 1) {
        return {
          kind: 'completed',
          output: [],
          calls: [{ callId: 'call_1', name: 'read_file', arguments: '{"path":"note.txt"}' }],
          text: '',
          requestId: null
        }
      }
      return {
        kind: 'completed',
        output: [],
        calls: [{ callId: 'finish', name: 'submit_result', arguments: '{"outcome":"completed","summary":"Read note.txt"}' }],
        text: '',
        requestId: null
      }
    },
    executeTool: (name, argumentsText) => {
      executed += 1
      return executeTool(root, 'demo', name, argumentsText)
    },
    proposeMutation: () => ({
      execution: { state: 'rejected', output: JSON.stringify({ ok: false, error: 'unused' }) },
      operationId: null
    }),
    waitForApprovals: async () => [],
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: () => undefined
  })
  assert.equal(executed, 1)
  assert.equal(result.status, 'completed')
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'visible')
})

test('provider selection persists across a reopened database', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kern-provider-')), 'kern.sqlite')
  const first = new MissionDatabase(file)
  assert.equal(readProviderId(first), 'bharatcode')
  writeProviderId(first, 'cursor')
  const missing = providerSnapshot(first, { bharatcode: false, cursor: false })
  assert.equal(missing.state, 'not_configured')
  const stored = providerSnapshot(first, { bharatcode: true, cursor: true })
  assert.equal(stored.provider, 'cursor')
  assert.equal(stored.state, 'credentials_stored')
  first.close()
  const second = new MissionDatabase(file)
  assert.equal(readProviderId(second), 'cursor')
  const checked = await checkSelectedProvider({
    database: second,
    configured: { bharatcode: true, cursor: true },
    readKey: async () => secret,
    probe: async () => 'usage_restricted'
  })
  assert.equal(checked.state, 'usage_restricted')
  second.close()
  const third = new MissionDatabase(file)
  assert.equal(providerSnapshot(third, { bharatcode: true, cursor: true }).state, 'usage_restricted')
  third.close()
})

test('a signed-in Cursor session is checked without a stored key', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kern-cursor-login-')), 'kern.sqlite')
  const database = new MissionDatabase(file)
  writeProviderId(database, 'cursor')
  let probed = 'unset'
  const checked = await checkSelectedProvider({
    database,
    configured: { bharatcode: false, cursor: true },
    readKey: async () => null,
    probe: async (_provider, apiKey) => {
      probed = apiKey
      return 'verified'
    }
  })
  assert.equal(probed, '')
  assert.equal(checked.state, 'verified')
  assert.equal(checked.detail.includes('API key'), false)
  database.close()
})
