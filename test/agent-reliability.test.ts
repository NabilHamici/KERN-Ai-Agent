import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runAgentLoop, type ModelClient } from '../src/main/agent/loop.ts'
import { executeTool } from '../src/main/agent/tools.ts'
import { applyClaimedOperation, proposeMutation } from '../src/main/agent/mutations.ts'
import { AgentRuntime } from '../src/main/agent/runtime.ts'
import { MissionDatabase } from '../src/main/services/database.ts'
import { WorkspaceService } from '../src/main/services/workspace.ts'
import { AGENT_LIMITS } from '../src/shared/agent.ts'
import type { ProviderTurn } from '../src/main/agent/provider.ts'
import {
  honestSummary,
  resolveClaimedCompletion,
  snapshotFromOperations,
  toolFingerprint
} from '../src/main/agent/progress.ts'

const secret = 'bc_live_runtime_secret'

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kern-reliab-'))
}

function database(): MissionDatabase {
  return new MissionDatabase(path.join(temporaryDirectory(), 'kern.sqlite'))
}

function openWorkspace(db: MissionDatabase, root: string): WorkspaceService {
  const workspace = new WorkspaceService(db)
  workspace.open(root)
  return workspace
}

function completion(
  summary: string,
  outcome: 'completed' | 'blocked' | 'partially_completed' = 'completed'
): ProviderTurn {
  return {
    kind: 'completed',
    output: [
      {
        type: 'function_call',
        call_id: 'finish',
        name: 'submit_result',
        arguments: JSON.stringify({ outcome, summary })
      }
    ],
    calls: [
      {
        callId: 'finish',
        name: 'submit_result',
        arguments: JSON.stringify({ outcome, summary })
      }
    ],
    text: '',
    requestId: 'req-finish'
  }
}

test('empty list_files path is treated as workspace root success', () => {
  const root = temporaryDirectory()
  const result = executeTool(root, 'demo', 'list_files', '{"path":""}')
  assert.equal(result.state, 'success')
  const payload = JSON.parse(result.output) as { ok: boolean; outcome: string; path: string }
  assert.equal(payload.ok, true)
  assert.equal(payload.outcome, 'success')
  assert.equal(payload.path, '.')
})

test('identical list_files calls are rejected after the first success', async () => {
  const root = temporaryDirectory()
  const outputs: string[] = []
  let turns = 0
  const result = await runAgentLoop({
    prompt: 'Inspect files',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret,
    client: async () => {
      turns += 1
      if (turns === 1) {
        return {
          kind: 'completed',
          output: [{ type: 'function_call', call_id: 'one', name: 'list_files', arguments: '{"path":"."}' }],
          calls: [{ callId: 'one', name: 'list_files', arguments: '{"path":"."}' }],
          text: 'listing',
          requestId: null
        }
      }
      if (turns === 2) {
        return {
          kind: 'completed',
          output: [{ type: 'function_call', call_id: 'two', name: 'list_files', arguments: '{"path":"."}' }],
          calls: [{ callId: 'two', name: 'list_files', arguments: '{"path":"."}' }],
          text: 'listing again',
          requestId: null
        }
      }
      return completion('Stopped after repeated list.')
    },
    executeTool: (name, argumentsText, cache) => {
      const execution = executeTool(root, 'demo', name, argumentsText, cache)
      outputs.push(execution.output)
      return execution
    },
    proposeMutation: () => ({
      execution: { state: 'rejected', output: JSON.stringify({ ok: false, outcome: 'rejected', error: 'unused' }) },
      operationId: null
    }),
    waitForApprovals: async () => [],
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: () => undefined
  })
  assert.equal(result.status, 'completed')
  assert.equal(outputs.length, 1)
  assert.match(JSON.stringify(result.summary), /Stopped after repeated list/)
})

test('failed create_file keeps rejected outcome and does not claim success', () => {
  const root = temporaryDirectory()
  const db = database()
  const mission = db.createAgentMission(root, 'Create bad')
  const proposed = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'call-bad',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({ path: '../escape.txt', content: 'nope', explanation: 'bad' })
  })
  assert.equal(proposed.operation, null)
  assert.equal(proposed.execution.state, 'rejected')
  assert.match(proposed.execution.output, /outcome":"rejected"/)
  db.close()
})

test('delete approval remains awaiting_approval until resolved', async () => {
  const root = temporaryDirectory()
  fs.writeFileSync(path.join(root, 'note.txt'), 'hi')
  const db = database()
  const workspace = openWorkspace(db, root)
  let release!: (value: Array<{ callId: string; execution: { state: 'success' | 'rejected'; output: string } }>) => void
  const gate = new Promise<Array<{ callId: string; execution: { state: 'success' | 'rejected'; output: string } }>>((resolve) => {
    release = resolve
  })
  let turns = 0
  const statuses: string[] = []
  const loop = runAgentLoop({
    prompt: 'Delete note.txt',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret,
    client: async () => {
      turns += 1
      if (turns === 1) {
        return {
          kind: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'del',
              name: 'delete_file',
              arguments: JSON.stringify({ path: 'note.txt', explanation: 'delete note' })
            }
          ],
          calls: [
            {
              callId: 'del',
              name: 'delete_file',
              arguments: JSON.stringify({ path: 'note.txt', explanation: 'delete note' })
            }
          ],
          text: '',
          requestId: null
        }
      }
      if (turns === 2) {
        return {
          kind: 'completed',
          output: [{ type: 'function_call', call_id: 'read', name: 'read_file', arguments: '{"path":"note.txt"}' }],
          calls: [{ callId: 'read', name: 'read_file', arguments: '{"path":"note.txt"}' }],
          text: '',
          requestId: null
        }
      }
      return completion('Deleted note.txt after approval.')
    },
    executeTool: (name, argumentsText, cache) => executeTool(root, 'demo', name, argumentsText, cache),
    proposeMutation: (call) => {
      const mission = db.listAgentMissionsForWorkspace(root)[0] ?? db.createAgentMission(root, 'Delete note.txt')
      const proposed = proposeMutation({
        root,
        database: db,
        missionId: mission.id,
        callId: call.callId,
        workspacePath: root,
        name: 'delete_file',
        argumentsText: call.arguments
      })
      return { execution: proposed.execution, operationId: proposed.operation?.id ?? null }
    },
    waitForApprovals: async () => gate,
    listOperations: () => {
      const mission = db.listAgentMissionsForWorkspace(root)[0]
      return mission ? db.listAgentOperations(mission.id) : []
    },
    onStatus: (status) => statuses.push(status),
    onText: () => undefined,
    onTool: () => undefined
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(statuses.includes('awaiting_approval'), true)
  assert.equal(fs.existsSync(path.join(root, 'note.txt')), true)
  const mission = db.listAgentMissionsForWorkspace(root)[0]!
  const pending = db.listPendingAgentOperations(mission.id)[0]!
  release([
    {
      callId: 'del',
      execution: {
        state: 'success',
        output: JSON.stringify({
          ok: true,
          outcome: 'success',
          applied: true,
          path: 'note.txt',
          operationId: pending.id,
          status: 'applied'
        })
      }
    }
  ])
  db.finalizeAgentOperation(pending.id, 'applied', { appliedHash: 'x' })
  const result = await loop
  assert.equal(result.status, 'completed')
  assert.match(result.summary ?? '', /Deleted note\.txt|note\.txt/)
  assert.doesNotMatch(result.summary ?? '', /Proposed this mission|Discovered during exploration/)
  workspace
  db.close()
})

test('agent continues after successful automatic create operations', async () => {
  const root = temporaryDirectory()
  const db = database()
  const events: Array<{ type: string; status?: string; summary?: string }> = []
  let turns = 0
  const runtime = new AgentRuntime({
    database: db,
    workspace: openWorkspace(db, root),
    currentWorkspace: () => ({ path: root, name: 'demo' }),
    readApiKey: async () => secret,
    emit: (event) => {
      if (event.type === 'finished' || event.type === 'status') {
        events.push(event as { type: string; status?: string; summary?: string })
      }
    },
    client: async () => {
      turns += 1
      if (turns === 1) {
        return {
          kind: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'create',
              name: 'create_file',
              arguments: JSON.stringify({ path: 'hello.txt', content: 'world', explanation: 'hello file' })
            }
          ],
          calls: [
            {
              callId: 'create',
              name: 'create_file',
              arguments: JSON.stringify({ path: 'hello.txt', content: 'world', explanation: 'hello file' })
            }
          ],
          text: '',
          requestId: null
        }
      }
      if (turns === 2) {
        return {
          kind: 'completed',
          output: [{ type: 'function_call', call_id: 'read', name: 'read_file', arguments: '{"path":"hello.txt"}' }],
          calls: [{ callId: 'read', name: 'read_file', arguments: '{"path":"hello.txt"}' }],
          text: '',
          requestId: null
        }
      }
      return completion('Created hello.txt and confirmed the write.')
    }
  })
  const { missionId } = await runtime.submit('Create hello.txt')
  await runtime.finished()
  const transcript = runtime.transcript(missionId)
  assert.equal(transcript?.mission.status, 'completed')
  assert.equal(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), 'world')
  assert.match(transcript?.mission.summary ?? '', /Created hello\.txt|confirmed the write/)
  assert.doesNotMatch(transcript?.mission.summary ?? '', /Applied this mission:|Discovered during exploration/)
  assert.equal(events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'), false)
  assert.equal(events.some((event) => event.type === 'finished' && event.status === 'completed'), true)
  assert.ok(turns >= 3)
  db.close()
})

test('multi-file creates auto-apply without pending approvals', async () => {
  const root = temporaryDirectory()
  const db = database()
  const workspace = openWorkspace(db, root)
  const mission = db.createAgentMission(root, 'Scaffold')
  const first = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'a',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({ path: 'a.txt', content: 'a', explanation: 'a' })
  })
  const second = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'b',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({ path: 'b.txt', content: 'b', explanation: 'b' })
  })
  assert.equal(first.execution.state, 'success')
  assert.equal(second.execution.state, 'success')
  assert.equal(first.operation?.status, 'pending')
  assert.equal(second.operation?.status, 'pending')
  for (const proposed of [first, second]) {
    const claimed = db.claimAgentOperation(mission.id, proposed.operation!.id)
    assert.ok(claimed)
    const applied = applyClaimedOperation({
      root,
      database: db,
      workspace,
      record: claimed!,
      expectedFingerprint: claimed!.contentFingerprint
    })
    assert.equal(applied.ok, true)
  }
  assert.equal(db.listPendingAgentOperations(mission.id).length, 0)
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a')
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'b')
  db.close()
})

test('model stopping prematurely with applied work becomes partially_completed', async () => {
  const root = temporaryDirectory()
  const db = database()
  const mission = db.createAgentMission(root, 'Partial')
  const proposed = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'create',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({ path: 'only.json', content: '{}', explanation: 'partial' })
  })
  assert.ok(proposed.operation)
  db.finalizeAgentOperation(proposed.operation!.id, 'applied', { appliedHash: 'hash' })
  let turns = 0
  const result = await runAgentLoop({
    prompt: 'Build many files',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret,
    client: async (input) => {
      turns += 1
      input.onDelta('still planning the rest')
      return { kind: 'completed', output: [], calls: [], text: 'still planning the rest', requestId: null }
    },
    executeTool: (name, argumentsText, cache) => executeTool(root, 'demo', name, argumentsText, cache),
    proposeMutation: () => ({
      execution: { state: 'rejected', output: JSON.stringify({ ok: false, outcome: 'rejected', error: 'unused' }) },
      operationId: null
    }),
    waitForApprovals: async () => [],
    listOperations: () => db.listAgentOperations(mission.id),
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: () => undefined
  })
  assert.ok(turns <= AGENT_LIMITS.maxEmptyModelTurns + 1)
  assert.equal(result.status, 'partially_completed')
  assert.match(result.summary ?? '', /stopped|verification finished|progress/i)
  assert.doesNotMatch(result.summary ?? '', /Discovered during exploration/)
  db.close()
})

test('pending deletion with applied work reports partial completion instead of full block', () => {
  const snapshot = snapshotFromOperations([
    {
      id: '1',
      missionId: 'm',
      callId: 'c1',
      kind: 'create',
      path: 'package.json',
      toPath: null,
      explanation: 'x',
      status: 'applied',
      unifiedDiff: '',
      destructive: false,
      error: null,
      contentFingerprint: 'a',
      sourceOperationId: null,
      createdAt: '',
      resolvedAt: null
    },
    {
      id: '2',
      missionId: 'm',
      callId: 'c2',
      kind: 'delete',
      path: 'old.txt',
      toPath: null,
      explanation: 'x',
      status: 'pending',
      unifiedDiff: '',
      destructive: true,
      error: null,
      contentFingerprint: 'b',
      sourceOperationId: null,
      createdAt: '',
      resolvedAt: null
    }
  ])
  const resolved = resolveClaimedCompletion({ outcome: 'completed', summary: 'Done' }, snapshot)
  assert.equal(resolved.status, 'partially_completed')
  assert.match(resolved.summary, /Deletions still await approval/)
  assert.match(resolved.ledger, /Awaiting deletion approval: old\.txt/)
})

test('completion is refused while only pending deletions remain and nothing was applied', () => {
  const snapshot = snapshotFromOperations([
    {
      id: '1',
      missionId: 'm',
      callId: 'c',
      kind: 'delete',
      path: 'app.json',
      toPath: null,
      explanation: 'x',
      status: 'pending',
      unifiedDiff: '',
      destructive: true,
      error: null,
      contentFingerprint: 'fp',
      sourceOperationId: null,
      createdAt: '',
      resolvedAt: null
    }
  ])
  const resolved = resolveClaimedCompletion({ outcome: 'completed', summary: 'Done' }, snapshot)
  assert.equal(resolved.status, 'blocked')
  assert.match(resolved.summary, /await approval/i)
  assert.match(resolved.ledger, /Awaiting deletion approval: app\.json/)
})

test('honest summary distinguishes applied and pending deletions', () => {
  const summary = honestSummary(
    snapshotFromOperations([
      {
        id: '1',
        missionId: 'm',
        callId: 'c1',
        kind: 'create',
        path: 'package.json',
        toPath: null,
        explanation: 'x',
        status: 'applied',
        unifiedDiff: '',
        destructive: false,
        error: null,
        contentFingerprint: 'a',
        sourceOperationId: null,
        createdAt: '',
        resolvedAt: null
      },
      {
        id: '2',
        missionId: 'm',
        callId: 'c2',
        kind: 'delete',
        path: 'App.tsx',
        toPath: null,
        explanation: 'x',
        status: 'pending',
        unifiedDiff: '',
        destructive: true,
        error: null,
        contentFingerprint: 'b',
        sourceOperationId: null,
        createdAt: '',
        resolvedAt: null
      }
    ])
  )
  assert.match(summary, /Applied this mission: package\.json/)
  assert.match(summary, /Awaiting deletion approval: App\.tsx/)
  assert.equal(summary.includes('created successfully'), false)
})

test('automatic create result is visible to the model on the next turn', async () => {
  const root = temporaryDirectory()
  const db = database()
  const workspace = openWorkspace(db, root)
  const mission = db.createAgentMission(root, 'Create nested')
  let sawApplied = false
  let turns = 0
  const result = await runAgentLoop({
    prompt: 'Create nested/hello.txt',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret,
    client: async (input) => {
      turns += 1
      const serialized = JSON.stringify(input.input)
      if (serialized.includes('applied\\":true') && serialized.includes('nested/hello.txt')) {
        sawApplied = true
      }
      if (turns === 1) {
        return {
          kind: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'create',
              name: 'create_file',
              arguments: JSON.stringify({ path: 'nested/hello.txt', content: 'hello', explanation: 'nested file' })
            }
          ],
          calls: [
            {
              callId: 'create',
              name: 'create_file',
              arguments: JSON.stringify({ path: 'nested/hello.txt', content: 'hello', explanation: 'nested file' })
            }
          ],
          text: '',
          requestId: null
        }
      }
      if (turns === 2) {
        return {
          kind: 'completed',
          output: [{ type: 'function_call', call_id: 'read', name: 'read_file', arguments: '{"path":"nested/hello.txt"}' }],
          calls: [{ callId: 'read', name: 'read_file', arguments: '{"path":"nested/hello.txt"}' }],
          text: '',
          requestId: null
        }
      }
      return completion('Created nested/hello.txt')
    },
    executeTool: (name, argumentsText, cache) => executeTool(root, 'demo', name, argumentsText, cache),
    proposeMutation: (call) => {
      const proposed = proposeMutation({
        root,
        database: db,
        missionId: mission.id,
        callId: call.callId,
        workspacePath: root,
        name: 'create_file',
        argumentsText: call.arguments
      })
      if (!proposed.operation) {
        return { execution: proposed.execution, operationId: null }
      }
      const claimed = db.claimAgentOperation(mission.id, proposed.operation.id)
      if (!claimed) {
        return {
          execution: { state: 'failed', output: JSON.stringify({ ok: false, outcome: 'failed', error: 'claim failed' }) },
          operationId: null
        }
      }
      const applied = applyClaimedOperation({
        root,
        database: db,
        workspace,
        record: claimed,
        expectedFingerprint: claimed.contentFingerprint
      })
      return {
        execution: { state: applied.ok ? 'success' : 'failed', output: applied.output },
        operationId: null
      }
    },
    waitForApprovals: async () => [],
    listOperations: () => db.listAgentOperations(mission.id),
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: () => undefined
  })
  assert.equal(sawApplied, true)
  assert.equal(result.status, 'completed')
  assert.equal(fs.readFileSync(path.join(root, 'nested', 'hello.txt'), 'utf8'), 'hello')
  db.close()
})

test('repeated identical create failures stagnate and keep the tool error', async () => {
  let turns = 0
  const result = await runAgentLoop({
    prompt: 'Create a file',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret,
    client: async () => {
      turns += 1
      return {
        kind: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: `create-${turns}`,
            name: 'create_file',
            arguments: JSON.stringify({ path: 'blocked/file.txt', content: 'x', explanation: 'create' })
          }
        ],
        calls: [
          {
            callId: `create-${turns}`,
            name: 'create_file',
            arguments: JSON.stringify({ path: 'blocked/file.txt', content: 'x', explanation: 'create' })
          }
        ],
        text: 'still trying',
        requestId: null
      }
    },
    executeTool: () => ({ state: 'rejected', output: JSON.stringify({ ok: false, outcome: 'rejected', error: 'unused' }) }),
    proposeMutation: () => ({
      execution: {
        state: 'rejected',
        output: JSON.stringify({ ok: false, outcome: 'rejected', error: 'A parent path is not a directory.' })
      },
      operationId: null
    }),
    waitForApprovals: async () => [],
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: () => undefined
  })
  assert.ok(turns > 1)
  assert.ok(turns <= AGENT_LIMITS.maxEmptyModelTurns + 3)
  assert.equal(result.status, 'failed')
  assert.match(`${result.summary ?? ''}\n${result.error ?? ''}`, /A parent path is not a directory/)
  assert.match(`${result.summary ?? ''}\n${result.error ?? ''}`, /no meaningful progress/)
})

test('claimed completion without reading applied files stays partial', () => {
  const resolved = resolveClaimedCompletion(
    { outcome: 'completed', summary: 'The project is ready.' },
    snapshotFromOperations(
      [
        {
          id: '1',
          missionId: 'm',
          callId: 'c1',
          kind: 'create',
          path: 'package.json',
          toPath: null,
          explanation: 'x',
          status: 'applied',
          unifiedDiff: '',
          destructive: false,
          error: null,
          contentFingerprint: 'a',
          sourceOperationId: null,
          createdAt: '',
          resolvedAt: null
        }
      ],
      []
    )
  )
  assert.equal(resolved.status, 'partially_completed')
  assert.match(resolved.summary, /not read back/)
  assert.equal(resolved.summary.includes('ready to run'), false)
})

test('tool fingerprints normalize argument key order', () => {
  assert.equal(
    toolFingerprint('list_files', '{"path":"."}'),
    toolFingerprint('list_files', '{"path":"."}')
  )
  assert.equal(
    toolFingerprint('create_file', '{"path":"a","content":"1","explanation":"x"}'),
    toolFingerprint('create_file', '{"explanation":"x","content":"1","path":"a"}')
  )
})
