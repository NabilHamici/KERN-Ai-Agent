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
import { canTransition, mutationRequiresApproval } from '../src/shared/agent.ts'
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

function applyProposed(
  root: string,
  db: MissionDatabase,
  workspace: WorkspaceService,
  missionId: string,
  operationId: string
) {
  const claimed = db.claimAgentOperation(missionId, operationId)
  assert.ok(claimed)
  return applyClaimedOperation({
    root,
    database: db,
    workspace,
    record: claimed!,
    expectedFingerprint: claimed!.contentFingerprint
  })
}

test('awaiting_approval is reachable from executing and analyzing', () => {
  assert.equal(canTransition('executing', 'awaiting_approval'), true)
  assert.equal(canTransition('analyzing', 'awaiting_approval'), true)
  assert.equal(canTransition('awaiting_approval', 'verifying'), true)
  assert.equal(canTransition('awaiting_approval', 'analyzing'), true)
})

test('only delete_file requires approval in the mutation policy', () => {
  assert.equal(mutationRequiresApproval('create_file'), false)
  assert.equal(mutationRequiresApproval('edit_file'), false)
  assert.equal(mutationRequiresApproval('rename_file'), false)
  assert.equal(mutationRequiresApproval('restore_file'), false)
  assert.equal(mutationRequiresApproval('delete_file'), true)
})

test('mutation tools cannot bypass the broker through executeTool', () => {
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
    workspacePath: root,
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
    workspacePath: root,
    name: 'edit_file',
    argumentsText: JSON.stringify({ path: '.env', content: 'x', explanation: 'secret' })
  })
  assert.equal(env.execution.state, 'rejected')

  const extra = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'c3',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({ path: 'a.txt', content: 'hi', explanation: 'ok', extra: true })
  })
  assert.equal(extra.execution.state, 'rejected')
  assert.match(extra.execution.output, /unrecognized key/)
})

test('create and edit auto-apply without approval and record history', async () => {
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
    if (turns === 2) {
      return {
        kind: 'completed',
        output: [
          { type: 'function_call', call_id: 'r1', name: 'read_file', arguments: '{"path":"note.txt"}' },
          { type: 'function_call', call_id: 'r2', name: 'read_file', arguments: '{"path":"new.txt"}' }
        ],
        calls: [
          { callId: 'r1', name: 'read_file', arguments: '{"path":"note.txt"}' },
          { callId: 'r2', name: 'read_file', arguments: '{"path":"new.txt"}' }
        ],
        text: '',
        requestId: 'req-read'
      }
    }
    return completion('Applied the create and edit.')
  }
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
    client
  })
  const { missionId } = await runtime.submit('Edit files')
  await runtime.finished()
  assert.equal(db.listPendingAgentOperations(missionId).length, 0)
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'beta')
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'fresh')
  assert.equal(runtime.transcript(missionId)?.mission.status, 'completed')
  assert.equal(events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'), false)
  const ops = db.listAgentOperations(missionId)
  assert.equal(ops.every((op) => op.status === 'applied'), true)
  assert.equal(ops.every((op) => op.contentFingerprint.length === 64), true)
  const changes = workspace.listFileChanges(20, 'open')
  const note = changes.find((change) => change.relativePath === 'note.txt')
  const created = changes.find((change) => change.relativePath === 'new.txt')
  assert.ok(note)
  assert.ok(created)
  assert.equal(note!.changeType, 'write')
  assert.equal(created!.changeType, 'create')
  assert.equal(note!.hasReverse, true)
  assert.equal(created!.hasReverse, false)
  const records = ops.map((op) => db.getAgentOperationRecord(op.id))
  assert.ok(records.every((record) => record?.appliedHash && record.appliedHash.length === 64))
})

test('rename auto-applies without approval', async () => {
  const { root, db, workspace } = harness()
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
            call_id: 'ren',
            name: 'rename_file',
            arguments: JSON.stringify({ path: 'old.txt', to: 'new-name.txt', explanation: 'Rename file' })
          }
        ],
        calls: [
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
    return completion('Renamed.')
  }
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
    client
  })
  const { missionId } = await runtime.submit('Rename')
  await runtime.finished()
  assert.equal(events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'), false)
  assert.equal(fs.existsSync(path.join(root, 'old.txt')), false)
  assert.equal(fs.readFileSync(path.join(root, 'new-name.txt'), 'utf8'), 'rename-me')
  assert.equal(db.listAgentOperations(missionId)[0]?.status, 'applied')
})

test('delete remains pending until explicit approval', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'gone.txt'), 'delete-me')
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
          }
        ],
        calls: [
          {
            callId: 'del',
            name: 'delete_file',
            arguments: JSON.stringify({ path: 'gone.txt', explanation: 'Remove obsolete file' })
          }
        ],
        text: '',
        requestId: 'req-1'
      }
    }
    return completion('Deleted.')
  }
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
    client
  })
  const { missionId } = await runtime.submit('Delete')
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'))
  assert.equal(fs.existsSync(path.join(root, 'gone.txt')), true)
  const pending = db.listPendingAgentOperations(missionId)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.kind, 'delete')
  assert.equal((await runtime.approve(missionId, pending[0]!.id)).applied, true)
  await runtime.finished()
  assert.equal(fs.existsSync(path.join(root, 'gone.txt')), false)
  restoreOperation({ root, database: db, workspace, operationId: pending[0]!.id })
  assert.equal(fs.readFileSync(path.join(root, 'gone.txt'), 'utf8'), 'delete-me')
})

test('rejected deletion leaves the original file intact', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'keep.txt'), 'safe')
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
            arguments: JSON.stringify({ path: 'keep.txt', explanation: 'Maybe delete' })
          }
        ],
        calls: [
          {
            callId: 'del',
            name: 'delete_file',
            arguments: JSON.stringify({ path: 'keep.txt', explanation: 'Maybe delete' })
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
  const { missionId } = await runtime.submit('Reject delete')
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'))
  const op = db.listPendingAgentOperations(missionId)[0]!
  await runtime.reject(missionId, op.id)
  await runtime.finished()
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'safe')
  assert.equal(db.getAgentOperation(op.id)?.status, 'rejected')
})

test('undo all reverses eligible automatic create and edit changes', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'note.txt'), 'alpha')
  let turns = 0
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: () => undefined,
    client: async () => {
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
            },
            {
              type: 'function_call',
              call_id: 'create1',
              name: 'create_file',
              arguments: JSON.stringify({ path: 'extra.txt', content: 'new', explanation: 'Create' })
            }
          ],
          calls: [
            {
              callId: 'edit1',
              name: 'edit_file',
              arguments: JSON.stringify({ path: 'note.txt', content: 'beta', explanation: 'Update' })
            },
            {
              callId: 'create1',
              name: 'create_file',
              arguments: JSON.stringify({ path: 'extra.txt', content: 'new', explanation: 'Create' })
            }
          ],
          text: '',
          requestId: 'req-1'
        }
      }
      return completion()
    }
  })
  await runtime.submit('Auto write')
  await runtime.finished()
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'beta')
  assert.equal(fs.readFileSync(path.join(root, 'extra.txt'), 'utf8'), 'new')
  const result = workspace.undoFileChanges()
  assert.ok(result.undone.length >= 2)
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'alpha')
  assert.equal(fs.existsSync(path.join(root, 'extra.txt')), false)
})

test('duplicate create becomes intentional edit instead of blind overwrite', () => {
  const { root, db, workspace } = harness()
  const mission = db.createAgentMission(root, 'dup')
  const first = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'c1',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({ path: 'app.json', content: '{"a":1}', explanation: 'first' })
  })
  assert.ok(first.operation)
  assert.equal(first.execution.state, 'success')
  const applied = applyProposed(root, db, workspace, mission.id, first.operation!.id)
  assert.equal(applied.ok, true)
  assert.equal(fs.readFileSync(path.join(root, 'app.json'), 'utf8'), '{"a":1}')

  const second = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'c2',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({ path: 'app.json', content: '{"a":2}', explanation: 'second' })
  })
  assert.ok(second.operation)
  assert.equal(second.operation?.kind, 'edit')
  const secondApplied = applyProposed(root, db, workspace, mission.id, second.operation!.id)
  assert.equal(secondApplied.ok, true)
  assert.equal(fs.readFileSync(path.join(root, 'app.json'), 'utf8'), '{"a":2}')

  const identical = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'c3',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({ path: 'app.json', content: '{"a":2}', explanation: 'same' })
  })
  assert.equal(identical.operation, null)
  assert.match(identical.execution.output, /noop/)
})

test('sequential intentional edits work and stale base hashes reject unsafe writes', () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'note.txt'), 'one')
  const mission = db.createAgentMission(root, 'edits')
  const first = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'e1',
    workspacePath: root,
    name: 'edit_file',
    argumentsText: JSON.stringify({ path: 'note.txt', content: 'two', explanation: 'first edit' })
  })
  assert.ok(first.operation)
  assert.equal(applyProposed(root, db, workspace, mission.id, first.operation!.id).ok, true)
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'two')

  const second = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'e2',
    workspacePath: root,
    name: 'edit_file',
    argumentsText: JSON.stringify({ path: 'note.txt', content: 'three', explanation: 'second edit' })
  })
  assert.ok(second.operation)
  assert.equal(applyProposed(root, db, workspace, mission.id, second.operation!.id).ok, true)
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'three')

  const stale = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'e3',
    workspacePath: root,
    name: 'edit_file',
    argumentsText: JSON.stringify({ path: 'note.txt', content: 'stale-write', explanation: 'stale' })
  })
  assert.ok(stale.operation)
  fs.writeFileSync(path.join(root, 'note.txt'), 'changed-outside')
  const staleApply = applyProposed(root, db, workspace, mission.id, stale.operation!.id)
  assert.equal(staleApply.ok, false)
  assert.equal(staleApply.operation.status, 'stale')
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'changed-outside')
})

test('multiple files can be generated in one mission without approval pauses', async () => {
  const { root, db, workspace } = harness()
  let turns = 0
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: () => undefined,
    client: async () => {
      turns += 1
      if (turns === 1) {
        const files = [
          ['package.json', '{"name":"demo"}'],
          ['index.ts', 'export const ok = true'],
          ['README.md', '# demo']
        ]
        const calls = files.map(([filePath, content], index) => ({
          callId: `c${index}`,
          name: 'create_file',
          arguments: JSON.stringify({ path: filePath, content, explanation: `Add ${filePath}` })
        }))
        return {
          kind: 'completed',
          output: calls.map((call) => ({
            type: 'function_call',
            call_id: call.callId,
            name: call.name,
            arguments: call.arguments
          })),
          calls,
          text: '',
          requestId: 'req-1'
        }
      }
      return completion('Scaffolded.')
    }
  })
  const { missionId } = await runtime.submit('Scaffold project')
  await runtime.finished()
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), '{"name":"demo"}')
  assert.equal(fs.readFileSync(path.join(root, 'index.ts'), 'utf8'), 'export const ok = true')
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# demo')
  assert.equal(db.listPendingAgentOperations(missionId).length, 0)
  assert.equal(db.listAgentOperations(missionId).filter((op) => op.status === 'applied').length, 3)
})

test('pending deletion does not prevent unrelated automatic create work from applying', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'victim.txt'), 'bye')
  const events: AgentEvent[] = []
  let turns = 0
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: (event) => events.push(event),
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
              arguments: JSON.stringify({ path: 'alive.txt', content: 'ok', explanation: 'safe create' })
            },
            {
              type: 'function_call',
              call_id: 'del',
              name: 'delete_file',
              arguments: JSON.stringify({ path: 'victim.txt', explanation: 'needs approval' })
            }
          ],
          calls: [
            {
              callId: 'create',
              name: 'create_file',
              arguments: JSON.stringify({ path: 'alive.txt', content: 'ok', explanation: 'safe create' })
            },
            {
              callId: 'del',
              name: 'delete_file',
              arguments: JSON.stringify({ path: 'victim.txt', explanation: 'needs approval' })
            }
          ],
          text: '',
          requestId: 'req-1'
        }
      }
      return completion('Created file; deletion still pending.')
    }
  })
  const { missionId } = await runtime.submit('Mixed')
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'awaiting_approval'))
  assert.equal(fs.readFileSync(path.join(root, 'alive.txt'), 'utf8'), 'ok')
  assert.equal(fs.existsSync(path.join(root, 'victim.txt')), true)
  const pending = db.listPendingAgentOperations(missionId)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.kind, 'delete')
  await runtime.reject(missionId, pending[0]!.id)
  await runtime.finished()
  const status = runtime.transcript(missionId)?.mission.status
  assert.equal(status === 'partially_completed' || status === 'completed' || status === 'blocked', true)
  assert.equal(fs.readFileSync(path.join(root, 'alive.txt'), 'utf8'), 'ok')
  assert.equal(fs.existsSync(path.join(root, 'victim.txt')), true)
})

test('approval and cancellation cannot race into a double delete apply', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'race.txt'), 'alpha')
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
            arguments: JSON.stringify({ path: 'race.txt', explanation: 'Race delete' })
          }
        ],
        calls: [
          {
            callId: 'del',
            name: 'delete_file',
            arguments: JSON.stringify({ path: 'race.txt', explanation: 'Race delete' })
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
    assert.equal(fs.existsSync(path.join(root, 'race.txt')), false)
  } else {
    assert.equal(fs.readFileSync(path.join(root, 'race.txt'), 'utf8'), 'alpha')
  }
  assert.equal(db.listPendingAgentOperations(missionId).length, 0)
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
    workspacePath: root,
    name: 'edit_file',
    argumentsText: JSON.stringify({ path: 'note.txt', content: 'beta', explanation: 'Update' })
  })
  assert.ok(proposed.operation)
  const applied = applyProposed(root, db, workspace, mission.id, proposed.operation!.id)
  assert.equal(applied.ok, true)
  fs.writeFileSync(path.join(root, 'note.txt'), 'later-user-edit')
  assert.throws(
    () => restoreOperation({ root, database: db, workspace, operationId: proposed.operation!.id }),
    /changed after this operation/
  )
  assert.equal(contentHash('later-user-edit').length, 64)
})

test('nested create_file builds missing directories and persists history', () => {
  const { root, db, workspace } = harness()
  const mission = db.createAgentMission(root, 'nested')
  const proposed = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'layout',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({
      path: 'app/_layout.tsx',
      content: 'export default function Layout(){return null}',
      explanation: 'Root layout'
    })
  })
  assert.equal(proposed.execution.state, 'success')
  assert.ok(proposed.operation)
  const applied = applyProposed(root, db, workspace, mission.id, proposed.operation!.id)
  assert.equal(applied.ok, true)
  assert.match(applied.output, /"applied":true/)
  assert.match(applied.output, /app\/_layout\.tsx/)
  assert.equal(fs.readFileSync(path.join(root, 'app', '_layout.tsx'), 'utf8'), 'export default function Layout(){return null}')
  const record = db.getAgentOperationRecord(proposed.operation!.id)
  assert.equal(record?.status, 'applied')
  assert.equal(record?.appliedHash?.length, 64)
  const change = workspace.listFileChanges(10, 'open').find((item) => item.relativePath === 'app/_layout.tsx')
  assert.equal(change?.changeType, 'create')
})

test('create through a symlink or a file parent is rejected without writing', () => {
  const { root, db, workspace } = harness()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'hidden')
  fs.symlinkSync(outside, path.join(root, 'escape-link'))
  fs.writeFileSync(path.join(root, 'app'), 'not-a-directory')
  const mission = db.createAgentMission(root, 'unsafe create')
  const escaped = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'esc',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({ path: 'escape-link/pwn.txt', content: 'no', explanation: 'escape' })
  })
  assert.equal(escaped.operation, null)
  assert.match(escaped.execution.output, /escapes the workspace|Path escapes/)
  assert.equal(fs.existsSync(path.join(outside, 'pwn.txt')), false)

  const blocked = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'bad-parent',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({ path: 'app/_layout.tsx', content: 'no', explanation: 'nested' })
  })
  assert.equal(blocked.operation, null)
  assert.match(blocked.execution.output, /Not a directory/)
  assert.equal(fs.readFileSync(path.join(root, 'app'), 'utf8'), 'not-a-directory')
  assert.equal(workspace.listFileChanges(10, 'open').some((item) => item.relativePath === 'app/_layout.tsx'), false)
})

test('multi-file project generation records operations and undo reverses them', async () => {
  const { root, db, workspace } = harness()
  const files = [
    ['package.json', '{"name":"sample"}'],
    ['app/_layout.tsx', 'export default function Layout(){return null}'],
    ['app/index.tsx', 'export default function Screen(){return null}'],
    ['src/format.ts', 'export const title = "sample"']
  ]
  let turns = 0
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => secret,
    emit: () => undefined,
    client: async () => {
      turns += 1
      if (turns === 1) {
        const calls = files.map(([filePath, content], index) => ({
          callId: `c${index}`,
          name: 'create_file',
          arguments: JSON.stringify({ path: filePath, content, explanation: `Add ${filePath}` })
        }))
        return {
          kind: 'completed' as const,
          output: calls.map((call) => ({
            type: 'function_call',
            call_id: call.callId,
            name: call.name,
            arguments: call.arguments
          })),
          calls,
          text: '',
          requestId: 'req-1'
        }
      }
      if (turns === 2) {
        const reads = files.map(([filePath], index) => ({
          callId: `r${index}`,
          name: 'read_file',
          arguments: JSON.stringify({ path: filePath })
        }))
        return {
          kind: 'completed' as const,
          output: reads.map((call) => ({
            type: 'function_call',
            call_id: call.callId,
            name: call.name,
            arguments: call.arguments
          })),
          calls: reads,
          text: '',
          requestId: 'req-read'
        }
      }
      return completion('Generated the project files. Dependencies were not installed.')
    }
  })
  const { missionId } = await runtime.submit('Generate a small project')
  await runtime.finished()
  for (const [filePath, content] of files) {
    assert.equal(fs.readFileSync(path.join(root, ...filePath.split('/')), 'utf8'), content)
  }
  const ops = db.listAgentOperations(missionId)
  assert.equal(ops.length, files.length)
  assert.equal(ops.every((op) => op.status === 'applied' && op.kind === 'create'), true)
  const changes = workspace.listFileChanges(20, 'open')
  assert.equal(files.every(([filePath]) => changes.some((change) => change.relativePath === filePath)), true)
  assert.equal(runtime.transcript(missionId)?.mission.status, 'completed')
  assert.match(runtime.transcript(missionId)?.mission.summary ?? '', /Generated the project files|Dependencies were not installed/)
  assert.doesNotMatch(runtime.transcript(missionId)?.mission.summary ?? '', /Discovered during exploration|Proposed this mission/)
  const undone = workspace.undoFileChanges()
  assert.equal(undone.undone.length, files.length)
  for (const [filePath] of files) {
    assert.equal(fs.existsSync(path.join(root, ...filePath.split('/'))), false)
  }
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
