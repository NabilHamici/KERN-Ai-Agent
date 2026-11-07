import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentRuntime } from '../src/main/agent/runtime.ts'
import { applyClaimedOperation, contentHash, proposeMutation, restoreOperation } from '../src/main/agent/mutations.ts'
import { executeTool } from '../src/main/agent/tools.ts'
import { MissionDatabase } from '../src/main/services/database.ts'
import { WorkspaceService } from '../src/main/services/workspace.ts'
import { canTransition } from '../src/shared/agent.ts'
import type { AgentEvent } from '../src/shared/agent.ts'
import type { ModelClient } from '../src/main/agent/loop.ts'
import type { ProviderTurn } from '../src/main/agent/provider.ts'

const secret = 'bc_mutation_secret'

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kern-mutate-'))
}

function harness(root = temporaryDirectory()): {
  root: string
  db: MissionDatabase
  workspace: WorkspaceService
} {
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const workspace = new WorkspaceService(db)
  workspace.open(root)
  return { root, db, workspace }
}

function completion(summary = 'Done.'): ProviderTurn {
  return {
    kind: 'completed',
    output: [{ type: 'function_call', call_id: 'finish', name: 'submit_result', arguments: JSON.stringify({ outcome: 'completed', summary }) }],
    calls: [{ callId: 'finish', name: 'submit_result', arguments: JSON.stringify({ outcome: 'completed', summary }) }],
    text: '',
    requestId: 'req-finish'
  }
}

test('awaiting_approval is reachable from executing and analyzing', () => {
  assert.equal(canTransition('executing', 'awaiting_approval'), true)
  assert.equal(canTransition('analyzing', 'awaiting_approval'), true)
  assert.equal(canTransition('awaiting_approval', 'verifying'), true)
  assert.equal(canTransition('awaiting_approval', 'analyzing'), true)
})

test('mutation tools cannot bypass approval through executeTool', () => {
  const { root } = harness()
  for (const name of ['create_file', 'edit_file', 'delete_file', 'rename_file', 'write_file']) {
    const result = executeTool(root, 'demo', name, '{"path":"x.txt","content":"no","explanation":"x"}')
    assert.equal(result.state, 'rejected')
    assert.match(result.output, /not available/)
  }
})

test('invalid proposals and path escapes are rejected', () => {
  const { root, db } = harness()
  const mission = db.createAgentMission(root, 'edit')
  const traversal = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'c1',
    name: 'edit_file',
    argumentsText: JSON.stringify({ path: '../secret.txt', content: 'x', explanation: 'escape' })
  })
  assert.equal(traversal.execution.state, 'rejected')
  assert.equal(traversal.operation, null)

  const env = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'c2',
    name: 'edit_file',
    argumentsText: JSON.stringify({ path: '.env', content: 'x', explanation: 'secret' })
  })
  assert.equal(env.execution.state, 'rejected')

  const extra = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'c3',
    name: 'create_file',
    argumentsText: JSON.stringify({ path: 'a.txt', content: 'hi', explanation: 'ok', extra: true })
  })
  assert.equal(extra.execution.state, 'rejected')
  assert.match(extra.execution.output, /unrecognized key/)
})

test('approve applies create and edit; duplicate approve is idempotent', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'note.txt'), 'alpha')
  const events: AgentEvent[] = []
  let turns = 0
  const client: ModelClient = async () => {
    turns += 1
    if (turns === 1) {
      return {
        kind: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'edit1',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'note.txt', content: 'beta', explanation: 'Update note' })
          },
          {
            type: 'function_call',
            call_id: 'create1',
            name: 'create_file',
            arguments: JSON.stringify({ path: 'new.txt', content: 'fresh', explanation: 'Add file' })
          }
        ],
        calls: [
          {
            callId: 'edit1',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'note.txt', content: 'beta', explanation: 'Update note' })
          },
          {
            callId: 'create1',
            name: 'create_file',
            arguments: JSON.stringify({ path: 'new.txt', content: 'fresh', explanation: 'Add file' })
          }
        ],
        text: '',
        requestId: 'req-1'
      }
    }
    return completion('Verified.')
  }
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
    client
  })
  const { missionId } = await runtime.submit('Edit files')
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'))
  const ops = db.listPendingAgentOperations(missionId)
  assert.equal(ops.length, 2)
  assert.equal(ops.every((op) => op.contentFingerprint.length === 64), true)

  const first = await runtime.approve(missionId, ops[0]!.id)
  assert.equal(first.applied, true)
  assert.equal(first.duplicate, false)
  const again = await runtime.approve(missionId, ops[0]!.id)
  assert.equal(again.applied, true)
  assert.equal(again.duplicate, true)
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'beta')

  const second = await runtime.approve(missionId, ops[1]!.id)
  assert.equal(second.applied, true)
  await runtime.finished()
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'fresh')
  assert.equal(runtime.transcript(missionId)?.mission.status, 'completed')
  assert.equal(events.some((event) => event.type === 'proposal'), true)
})

test('stale proposal is refused when the file changes after propose', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'note.txt'), 'alpha')
  const events: AgentEvent[] = []
  let turns = 0
  const client: ModelClient = async () => {
    turns += 1
    if (turns === 1) {
      return {
        kind: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'edit1',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'note.txt', content: 'beta', explanation: 'Update' })
          }
        ],
        calls: [
          {
            callId: 'edit1',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'note.txt', content: 'beta', explanation: 'Update' })
          }
        ],
        text: '',
        requestId: 'req-1'
      }
    }
    return completion()
  }
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
    client
  })
  const { missionId } = await runtime.submit('Edit')
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'))
  const op = db.listPendingAgentOperations(missionId)[0]!
  fs.writeFileSync(path.join(root, 'note.txt'), 'changed-outside')
  const result = await runtime.approve(missionId, op.id)
  assert.equal(result.applied, false)
  assert.equal(result.status, 'stale')
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'changed-outside')
  await runtime.finished()
})

test('reject and cancel resolve pending ops without writing', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'note.txt'), 'alpha')
  const events: AgentEvent[] = []
  let turns = 0
  const client: ModelClient = async () => {
    turns += 1
    if (turns === 1) {
      return {
        kind: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'edit1',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'note.txt', content: 'beta', explanation: 'Update' })
          }
        ],
        calls: [
          {
            callId: 'edit1',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'note.txt', content: 'beta', explanation: 'Update' })
          }
        ],
        text: '',
        requestId: 'req-1'
      }
    }
    return completion()
  }
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
    client
  })
  const { missionId } = await runtime.submit('Edit')
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'))
  const op = db.listPendingAgentOperations(missionId)[0]!
  await runtime.reject(missionId, op.id)
  await runtime.finished()
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'alpha')
  assert.equal(db.getAgentOperation(op.id)?.status, 'rejected')

  const events2: AgentEvent[] = []
  turns = 0
  const runtime2 = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: (event) => events2.push(event),
    client
  })
  const second = await runtime2.submit('Edit again')
  await waitFor(() => events2.some((event) => event.type === 'status' && event.status === 'awaiting_approval'))
  const pending = db.listPendingAgentOperations(second.missionId)[0]!
  assert.equal(runtime2.cancel(second.missionId).cancelled, true)
  await runtime2.finished()
  assert.equal(db.getAgentOperation(pending.id)?.status, 'cancelled')
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'alpha')
})

test('approval and cancellation cannot race into a double apply', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'note.txt'), 'alpha')
  const events: AgentEvent[] = []
  let turns = 0
  const client: ModelClient = async () => {
    turns += 1
    if (turns === 1) {
      return {
        kind: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'edit1',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'note.txt', content: 'beta', explanation: 'Update' })
          }
        ],
        calls: [
          {
            callId: 'edit1',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'note.txt', content: 'beta', explanation: 'Update' })
          }
        ],
        text: '',
        requestId: 'req-1'
      }
    }
    return completion()
  }
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
    client
  })
  const { missionId } = await runtime.submit('Race')
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'))
  const op = db.listPendingAgentOperations(missionId)[0]!
  const approve = runtime.approve(missionId, op.id).then(
    (value) => value,
    () => ({ applied: false, duplicate: false, status: 'cancelled' })
  )
  const cancel = Promise.resolve(runtime.cancel(missionId))
  const [approved, cancelled] = await Promise.all([approve, cancel])
  await runtime.finished()
  assert.equal(cancelled.cancelled, true)
  const status = db.getAgentOperation(op.id)?.status
  assert.equal(status === 'applied' || status === 'cancelled', true)
  if (status === 'applied') {
    assert.equal(approved.applied, true)
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'beta')
  } else {
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'alpha')
  }
  assert.equal(db.listPendingAgentOperations(missionId).length, 0)
})

test('partial batch failure leaves successful applies intact', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'keep.txt'), 'one')
  fs.writeFileSync(path.join(root, 'stale.txt'), 'old')
  const events: AgentEvent[] = []
  let turns = 0
  const client: ModelClient = async () => {
    turns += 1
    if (turns === 1) {
      return {
        kind: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'ok',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'keep.txt', content: 'two', explanation: 'ok' })
          },
          {
            type: 'function_call',
            call_id: 'bad',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'stale.txt', content: 'new', explanation: 'will stale' })
          }
        ],
        calls: [
          {
            callId: 'ok',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'keep.txt', content: 'two', explanation: 'ok' })
          },
          {
            callId: 'bad',
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'stale.txt', content: 'new', explanation: 'will stale' })
          }
        ],
        text: '',
        requestId: 'req-1'
      }
    }
    return completion()
  }
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
    client
  })
  const { missionId } = await runtime.submit('Batch')
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'))
  const ops = db.listPendingAgentOperations(missionId)
  const keep = ops.find((op) => op.path === 'keep.txt')!
  const stale = ops.find((op) => op.path === 'stale.txt')!
  fs.writeFileSync(path.join(root, 'stale.txt'), 'changed')
  assert.equal((await runtime.approve(missionId, keep.id)).applied, true)
  assert.equal((await runtime.approve(missionId, stale.id)).status, 'stale')
  await runtime.finished()
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'two')
  assert.equal(fs.readFileSync(path.join(root, 'stale.txt'), 'utf8'), 'changed')
})

test('delete and rename require approval and support restore after applied hash check', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'gone.txt'), 'delete-me')
  fs.writeFileSync(path.join(root, 'old.txt'), 'rename-me')
  const events: AgentEvent[] = []
  let turns = 0
  const client: ModelClient = async () => {
    turns += 1
    if (turns === 1) {
      return {
        kind: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'del',
            name: 'delete_file',
            arguments: JSON.stringify({ path: 'gone.txt', explanation: 'Remove obsolete file' })
          },
          {
            type: 'function_call',
            call_id: 'ren',
            name: 'rename_file',
            arguments: JSON.stringify({ path: 'old.txt', to: 'new-name.txt', explanation: 'Rename file' })
          }
        ],
        calls: [
          {
            callId: 'del',
            name: 'delete_file',
            arguments: JSON.stringify({ path: 'gone.txt', explanation: 'Remove obsolete file' })
          },
          {
            callId: 'ren',
            name: 'rename_file',
            arguments: JSON.stringify({ path: 'old.txt', to: 'new-name.txt', explanation: 'Rename file' })
          }
        ],
        text: '',
        requestId: 'req-1'
      }
    }
    return completion()
  }
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
    client
  })
  const { missionId } = await runtime.submit('Destructive')
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'))
  const ops = db.listPendingAgentOperations(missionId)
  assert.equal(ops.every((op) => op.destructive), true)
  for (const op of ops) {
    assert.equal((await runtime.approve(missionId, op.id)).applied, true)
  }
  await runtime.finished()
  assert.equal(fs.existsSync(path.join(root, 'gone.txt')), false)
  assert.equal(fs.existsSync(path.join(root, 'new-name.txt')), true)

  const deleted = ops.find((op) => op.kind === 'delete')!
  restoreOperation({ root, database: db, workspace, operationId: deleted.id })
  assert.equal(fs.readFileSync(path.join(root, 'gone.txt'), 'utf8'), 'delete-me')

  const renamed = db.getAgentOperationRecord(ops.find((op) => op.kind === 'rename')!.id)!
  fs.writeFileSync(path.join(root, 'new-name.txt'), 'tampered')
  assert.throws(
    () => restoreOperation({ root, database: db, workspace, operationId: renamed.id }),
    /changed after this operation/
  )
})

test('restore refuses when the post-application file was modified', () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'note.txt'), 'alpha')
  const mission = db.createAgentMission(root, 'edit')
  const proposed = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'c1',
    name: 'edit_file',
    argumentsText: JSON.stringify({ path: 'note.txt', content: 'beta', explanation: 'Update' })
  })
  assert.ok(proposed.operation)
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
  fs.writeFileSync(path.join(root, 'note.txt'), 'later-user-edit')
  assert.throws(
    () => restoreOperation({ root, database: db, workspace, operationId: proposed.operation!.id }),
    /changed after this operation/
  )
  assert.equal(contentHash('later-user-edit').length, 64)
})

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
