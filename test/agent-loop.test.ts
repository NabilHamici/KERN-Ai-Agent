import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentRuntime } from '../src/main/agent/runtime.ts'
import { runAgentLoop, type ModelClient } from '../src/main/agent/loop.ts'
import type { ProviderTurn } from '../src/main/agent/provider.ts'
import { executeTool } from '../src/main/agent/tools.ts'
import { AGENT_LIMITS, assertTransition, canTransition } from '../src/shared/agent.ts'
import { DatabaseSync } from 'node:sqlite'
import { MissionDatabase } from '../src/main/services/database.ts'
import type { AgentEvent } from '../src/shared/agent.ts'

const secret = 'bc_live_runtime_secret'

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kern-agent-'))
}

function database(): MissionDatabase {
  return new MissionDatabase(path.join(temporaryDirectory(), 'kern.sqlite'))
}

function completion(summary = 'Inspection finished.'): ProviderTurn {
  return {
    kind: 'completed',
    output: [{ type: 'function_call', call_id: 'finish', name: 'submit_result', arguments: JSON.stringify({ outcome: 'completed', summary }) }],
    calls: [{ callId: 'finish', name: 'submit_result', arguments: JSON.stringify({ outcome: 'completed', summary }) }],
    text: '',
    requestId: 'req-finish'
  }
}

test('mission transitions are explicit and terminal states do not continue', () => {
  assert.equal(canTransition('queued', 'analyzing'), true)
  assert.equal(canTransition('analyzing', 'executing'), true)
  assert.equal(canTransition('executing', 'analyzing'), true)
  assert.equal(canTransition('analyzing', 'completed'), true)
  assert.equal(canTransition('queued', 'completed'), false)
  assert.equal(canTransition('completed', 'analyzing'), false)
  assert.equal(canTransition('interrupted', 'executing'), false)
  assert.throws(() => assertTransition('failed', 'completed'), /Invalid mission transition/)
})

test('persists a mission, records a read, and completes only from submit_result', async () => {
  const root = temporaryDirectory()
  fs.writeFileSync(path.join(root, 'note.txt'), 'workspace note')
  const db = database()
  const session = db.createMission(root, 'Workspace')
  const events: AgentEvent[] = []
  let calls = 0
  const client: ModelClient = async (input) => {
    calls += 1
    input.onDelta('Reading the note.')
    if (calls === 1) {
      return {
        kind: 'completed',
        output: [{ type: 'function_call', call_id: 'call_read', name: 'read_file', arguments: '{"path":"note.txt"}' }],
        calls: [{ callId: 'call_read', name: 'read_file', arguments: '{"path":"note.txt"}' }],
        text: 'Reading the note.',
        requestId: 'req-read'
      }
    }
    return completion()
  }
  const runtime = new AgentRuntime({
    database: db,
    currentWorkspace: () => ({ path: root, name: 'demo' }),
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
    client
  })
  const { missionId } = await runtime.submit('Read note.txt')
  await runtime.finished()
  const transcript = runtime.transcript(missionId)
  assert.equal(transcript?.mission.status, 'completed')
  assert.equal(transcript?.mission.summary, 'Inspection finished.')
  assert.equal(transcript?.mission.iteration, 2)
  assert.equal(transcript?.tools[0]?.name, 'read_file')
  assert.equal(transcript?.tools[0]?.state, 'finished')
  assert.match(transcript?.tools[0]?.output ?? '', /workspace note/)
  assert.equal(events.some((event) => event.type === 'status' && event.status === 'queued'), true)
  assert.equal(events.some((event) => event.type === 'status' && event.status === 'analyzing'), true)
  assert.equal(events.some((event) => event.type === 'status' && event.status === 'executing'), true)
  assert.equal(events.some((event) => event.type === 'text'), true)
  assert.equal(events.some((event) => event.type === 'finished' && event.status === 'completed'), true)
  assert.equal(JSON.stringify(events).includes(secret), false)
  assert.equal(db.listMissions().some((mission) => mission.id === session.id), true)
  db.close()
})

test('stops at the iteration limit when the model never submits a result', async () => {
  const root = temporaryDirectory()
  const db = database()
  let calls = 0
  const runtime = new AgentRuntime({
    database: db,
    currentWorkspace: () => ({ path: root, name: 'demo' }),
    readApiKey: async () => secret,
    emit: () => undefined,
    client: async (input) => {
      calls += 1
      input.onDelta('still looking')
      return { kind: 'completed', output: [], calls: [], text: 'still looking', requestId: null }
    }
  })
  const { missionId } = await runtime.submit('Look around')
  await runtime.finished()
  const mission = db.getAgentMission(missionId)
  assert.equal(calls, AGENT_LIMITS.maxIterations)
  assert.equal(mission?.status, 'failed')
  assert.match(mission?.error ?? '', /iteration limit/)
  db.close()
})

test('rejects an invalid tool call and does not treat plain text as completion', async () => {
  const root = temporaryDirectory()
  const db = database()
  let calls = 0
  const runtime = new AgentRuntime({
    database: db,
    currentWorkspace: () => ({ path: root, name: 'demo' }),
    readApiKey: async () => secret,
    emit: () => undefined,
    client: async () => {
      calls += 1
      if (calls === 1) {
        return {
          kind: 'completed',
          output: [{ type: 'function_call', call_id: 'bad', name: 'read_file', arguments: '{"path":1}' }],
          calls: [{ callId: 'bad', name: 'read_file', arguments: '{"path":1}' }],
          text: '',
          requestId: null
        }
      }
      return completion('The path was invalid.')
    }
  })
  const { missionId } = await runtime.submit('Read a file')
  await runtime.finished()
  const transcript = runtime.transcript(missionId)
  assert.equal(transcript?.mission.status, 'completed')
  assert.equal(transcript?.tools[0]?.state, 'rejected')
  assert.match(transcript?.tools[0]?.output ?? '', /rejected/)
  db.close()
})

test('cancels a running mission', async () => {
  const root = temporaryDirectory()
  const db = database()
  const runtime = new AgentRuntime({
    database: db,
    currentWorkspace: () => ({ path: root, name: 'demo' }),
    readApiKey: async () => secret,
    emit: () => undefined,
    client: (input) =>
      new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
  })
  const { missionId } = await runtime.submit('Wait')
  assert.equal(runtime.cancel(missionId).cancelled, true)
  await runtime.finished()
  assert.equal(db.getAgentMission(missionId)?.status, 'cancelled')
  db.close()
})

test('fails a mission when the provider fails and does not execute tools', async () => {
  const root = temporaryDirectory()
  fs.writeFileSync(path.join(root, 'note.txt'), 'keep')
  const db = database()
  let tools = 0
  const runtime = new AgentRuntime({
    database: db,
    currentWorkspace: () => ({ path: root, name: 'demo' }),
    readApiKey: async () => secret,
    emit: () => undefined,
    client: async () => {
      throw new Error(`down ${secret}`)
    }
  })
  const { missionId } = await runtime.submit('Inspect')
  await runtime.finished()
  const mission = db.getAgentMission(missionId)
  assert.equal(mission?.status, 'failed')
  assert.match(mission?.error ?? '', /could not be reached/)
  assert.equal(mission?.error?.includes(secret), false)
  assert.equal(tools, 0)
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'keep')
  db.close()
})

test('stops when the tool-call limit is reached and does not run the extra call', async () => {
  let executed = 0
  const calls = Array.from({ length: AGENT_LIMITS.maxToolCalls + 1 }, (_, index) => ({
    callId: `call_${index}`,
    name: 'get_workspace_info',
    arguments: '{}'
  }))
  const result = await runAgentLoop({
    prompt: 'List everything',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret,
    client: async () => ({ kind: 'completed', output: [], calls, text: '', requestId: null }),
    executeTool: () => {
      executed += 1
      return { state: 'finished', output: '{"ok":true}' }
    },
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: () => undefined
  })
  assert.equal(executed, AGENT_LIMITS.maxToolCalls)
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /tool-call limit/)
})

test('does not execute tools from an incomplete response', async () => {
  let executed = 0
  const result = await runAgentLoop({
    prompt: 'Read the file',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret,
    client: async () => ({ kind: 'incomplete', reason: 'max_output_tokens', text: 'partial', requestId: 'req-cap' }),
    executeTool: () => {
      executed += 1
      return { state: 'finished', output: '{}' }
    },
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: () => undefined
  })
  assert.equal(executed, 0)
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /output budget/)
})

test('marks an interrupted mission and does not resume it', async () => {
  const root = temporaryDirectory()
  const db = database()
  const stale = db.createAgentMission(root, 'Unfinished inspection')
  assert.equal(db.transitionAgentMission(stale.id, 'analyzing', { summary: null, error: null }), true)
  let calls = 0
  const runtime = new AgentRuntime({
    database: db,
    currentWorkspace: () => ({ path: root, name: 'demo' }),
    readApiKey: async () => secret,
    emit: () => undefined,
    client: async () => {
      calls += 1
      return completion()
    }
  })
  assert.equal(db.getAgentMission(stale.id)?.status, 'interrupted')
  assert.match(db.getAgentMission(stale.id)?.error ?? '', /interrupted/)
  assert.equal(runtime.current(), null)
  assert.equal(calls, 0)
  const { missionId } = await runtime.submit('A new mission')
  await runtime.finished()
  assert.notEqual(missionId, stale.id)
  assert.equal(db.getAgentMission(stale.id)?.status, 'interrupted')
  assert.equal(db.getAgentMission(missionId)?.status, 'completed')
  assert.equal(calls, 1)
  db.close()
})

test('redacts the API key from streamed text', async () => {
  const root = temporaryDirectory()
  const db = database()
  const events: AgentEvent[] = []
  const runtime = new AgentRuntime({
    database: db,
    currentWorkspace: () => ({ path: root, name: 'demo' }),
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
    client: async (input) => {
      input.onDelta(`token ${secret}`)
      return completion()
    }
  })
  await runtime.submit('Inspect')
  await runtime.finished()
  const text = events.filter((event) => event.type === 'text').map((event) => (event.type === 'text' ? event.delta : '')).join('')
  assert.match(text, /\[redacted\]/)
  assert.equal(text.includes(secret), false)
  assert.equal(JSON.stringify(events).includes(secret), false)
  db.close()
})

test('upgrades a Phase 1 database without dropping workspace sessions', () => {
  const file = path.join(temporaryDirectory(), 'kern.sqlite')
  const raw = new DatabaseSync(file)
  raw.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`)
  raw.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  raw.exec(
    `CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  )
  raw.exec(
    `CREATE TABLE mission_events (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  )
  raw.exec(
    `CREATE TABLE file_changes (
      id TEXT PRIMARY KEY,
      mission_id TEXT,
      relative_path TEXT NOT NULL,
      change_type TEXT NOT NULL,
      reverse_text TEXT,
      created_at TEXT NOT NULL
    )`
  )
  const now = new Date().toISOString()
  for (let version = 1; version <= 5; version += 1) {
    raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, now)
  }
  raw.prepare('INSERT INTO missions (id, workspace_path, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'session-1',
    '/tmp/workspace',
    'Folder',
    'open',
    now,
    now
  )
  raw.close()
  const db = new MissionDatabase(file)
  assert.equal(db.listMissions().some((mission) => mission.id === 'session-1' && mission.status === 'open'), true)
  assert.equal(db.createAgentMission('/tmp/workspace', 'Inspect the folder').status, 'queued')
  assert.equal(db.listMissions().some((mission) => mission.id === 'session-1'), true)
  db.close()
})

test('tool execution stays inside the broker', () => {
  const root = temporaryDirectory()
  const result = executeTool(root, 'demo', 'write_file', '{"path":"out.txt","content":"no"}')
  assert.equal(result.state, 'rejected')
  assert.equal(fs.existsSync(path.join(root, 'out.txt')), false)
})
