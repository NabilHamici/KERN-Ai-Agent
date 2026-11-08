import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentRuntime } from '../src/main/agent/runtime.ts'
import {
  applyClaimedOperation,
  listFileOperations,
  proposeMutation,
  restoreOperation
} from '../src/main/agent/mutations.ts'
import { MissionDatabase } from '../src/main/services/database.ts'
import { WorkspaceService } from '../src/main/services/workspace.ts'
import type { AgentEvent } from '../src/shared/agent.ts'
import type { ModelClient } from '../src/main/agent/loop.ts'
import type { ProviderTurn } from '../src/main/agent/provider.ts'

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kern-persist-'))
}

function harness(folder = temporaryDirectory()): {
  root: string
  dbPath: string
  db: MissionDatabase
  workspace: WorkspaceService
} {
  const dbPath = path.join(folder, 'kern.sqlite')
  const db = new MissionDatabase(dbPath)
  const workspace = new WorkspaceService(db)
  const info = workspace.open(folder)
  return { root: info.path, dbPath, db, workspace }
}

function reopen(dbPath: string, root: string): { db: MissionDatabase; workspace: WorkspaceService; runtime: AgentRuntime } {
  const db = new MissionDatabase(dbPath)
  const workspace = new WorkspaceService(db)
  workspace.restore()
  assert.equal(workspace.current()?.path, fs.realpathSync(root))
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => 'bc_persist_secret',
    emit: () => undefined
  })
  return { db, workspace, runtime }
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

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function applyDelete(root: string, db: MissionDatabase, workspace: WorkspaceService, relative: string): string {
  const mission = db.createAgentMission(root, `delete ${relative}`)
  const proposed = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: `del-${relative}-${Math.random().toString(16).slice(2)}`,
    workspacePath: root,
    name: 'delete_file',
    argumentsText: JSON.stringify({ path: relative, explanation: `Remove ${relative}` })
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
  return proposed.operation!.id
}

test('delete, restart, restore succeeds from persisted snapshot', () => {
  const { root, dbPath, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'keep.txt'), 'stay')
  fs.writeFileSync(path.join(root, 'gone.txt'), 'recover-me')
  const operationId = applyDelete(root, db, workspace, 'gone.txt')
  assert.equal(fs.existsSync(path.join(root, 'gone.txt')), false)
  db.close()

  const again = reopen(dbPath, root)
  const record = again.db.getAgentOperationRecord(operationId)
  assert.ok(record)
  assert.equal(record!.status, 'applied')
  assert.equal(record!.originalText, 'recover-me')
  restoreOperation({ root, database: again.db, workspace: again.workspace, operationId })
  assert.equal(fs.readFileSync(path.join(root, 'gone.txt'), 'utf8'), 'recover-me')
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'stay')
  again.db.close()
})

test('delete then restore after another file changes leaves the other file alone', () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha')
  fs.writeFileSync(path.join(root, 'b.txt'), 'beta')
  const deletedId = applyDelete(root, db, workspace, 'a.txt')
  fs.writeFileSync(path.join(root, 'b.txt'), 'beta-edited')
  restoreOperation({ root, database: db, workspace, operationId: deletedId })
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'alpha')
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'beta-edited')
  db.close()
})

test('restore refuses when the snapshot is missing', () => {
  const { root, db, workspace } = harness()
  const mission = db.createAgentMission(root, 'broken delete')
  const id = '12345678-1234-1234-1234-123456789abc'
  db.createAgentOperation({
    id,
    missionId: mission.id,
    callId: 'broken',
    kind: 'delete',
    path: 'missing-snap.txt',
    toPath: null,
    explanation: 'broken',
    originalText: null,
    proposedText: null,
    baseHash: null,
    contentFingerprint: 'fp',
    unifiedDiff: 'delete missing-snap.txt'
  })
  db.finalizeAgentOperation(id, 'applied', {})
  assert.throws(
    () => restoreOperation({ root, database: db, workspace, operationId: id }),
    /snapshot is incomplete/
  )
  db.close()
})

test('restore refuses unsafe filesystem state', () => {
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
  const claimed = db.claimAgentOperation(mission.id, proposed.operation!.id)
  assert.ok(claimed)
  assert.equal(
    applyClaimedOperation({
      root,
      database: db,
      workspace,
      record: claimed!,
      expectedFingerprint: claimed!.contentFingerprint
    }).ok,
    true
  )
  fs.writeFileSync(path.join(root, 'note.txt'), 'user-changed')
  assert.throws(
    () => restoreOperation({ root, database: db, workspace, operationId: proposed.operation!.id }),
    /changed after this operation/
  )
  db.close()
})

test('path-based restore matches a deletion from the current mission', () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'only.txt'), 'solo')
  const mission = db.createAgentMission(root, 'delete and restore')
  const deleted = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'del-only',
    workspacePath: root,
    name: 'delete_file',
    argumentsText: JSON.stringify({ path: 'only.txt', explanation: 'Remove only.txt' })
  })
  assert.ok(deleted.operation)
  const deletedClaim = db.claimAgentOperation(mission.id, deleted.operation!.id)
  assert.ok(deletedClaim)
  assert.equal(
    applyClaimedOperation({
      root,
      database: db,
      workspace,
      record: deletedClaim!,
      expectedFingerprint: deletedClaim!.contentFingerprint
    }).ok,
    true
  )
  const proposed = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'restore-1',
    workspacePath: root,
    name: 'restore_file',
    argumentsText: JSON.stringify({ path: 'only.txt', explanation: 'Restore the file deleted earlier' })
  })
  assert.ok(proposed.operation)
  assert.equal(proposed.operation!.kind, 'restore')
  assert.equal(proposed.operation!.sourceOperationId, deleted.operation!.id)
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
  assert.match(applied.output, /"restored":true/)
  assert.equal(fs.readFileSync(path.join(root, 'only.txt'), 'utf8'), 'solo')
  db.close()
})

test('path-based restore refuses older workspace history and asks for operationId', () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'only.txt'), 'solo')
  applyDelete(root, db, workspace, 'only.txt')
  const mission = db.createAgentMission(root, 'restore please')
  const proposed = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'restore-old',
    workspacePath: root,
    name: 'restore_file',
    argumentsText: JSON.stringify({ path: 'only.txt', explanation: 'Restore from older history' })
  })
  assert.equal(proposed.operation, null)
  assert.match(proposed.execution.output, /current mission/)
  db.close()
})

test('restore asks for clarification when multiple current-mission deletions match', () => {
  const { root, db, workspace } = harness()
  const mission = db.createAgentMission(root, 'which twin')
  for (const [index, content] of ['one', 'two'].entries()) {
    fs.writeFileSync(path.join(root, 'twin.txt'), content)
    const deleted = proposeMutation({
      root,
      database: db,
      missionId: mission.id,
      callId: `del-${index}`,
      workspacePath: root,
      name: 'delete_file',
      argumentsText: JSON.stringify({ path: 'twin.txt', explanation: `Remove twin ${index}` })
    })
    assert.ok(deleted.operation)
    const claimed = db.claimAgentOperation(mission.id, deleted.operation!.id)
    assert.ok(claimed)
    assert.equal(
      applyClaimedOperation({
        root,
        database: db,
        workspace,
        record: claimed!,
        expectedFingerprint: claimed!.contentFingerprint
      }).ok,
      true
    )
  }
  const proposed = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'restore-amb',
    workspacePath: root,
    name: 'restore_file',
    argumentsText: JSON.stringify({ path: 'twin.txt', explanation: 'Restore twin' })
  })
  assert.equal(proposed.operation, null)
  assert.match(proposed.execution.output, /ambiguous/)
  db.close()
})

test('missions and complete conversation history survive restart hydration', async () => {
  const { root, dbPath, db } = harness()
  const first = db.createAgentMission(root, 'First prompt')
  db.appendAgentMessage(first.id, 'assistant', 'First answer')
  db.recordAgentTool({
    missionId: first.id,
    callId: 't1',
    name: 'read_file',
    argumentsText: '{"path":"a.txt"}',
    state: 'finished',
    output: 'ok'
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = db.createAgentMission(root, 'Second prompt')
  db.appendAgentMessage(second.id, 'assistant', 'Second answer')
  const firstTranscript = db.agentTranscript(first.id)
  assert.ok(firstTranscript)
  assert.equal(firstTranscript!.mission.prompt, 'First prompt')
  assert.equal(firstTranscript!.messages.some((item) => item.content === 'First answer'), true)
  db.close()

  const again = reopen(dbPath, root)
  assert.equal(again.runtime.current(), null)
  const hydrated = again.runtime.hydrate()
  assert.ok(hydrated)
  assert.equal(hydrated!.mission.prompt, 'Second prompt')
  assert.equal(hydrated!.messages.some((item) => item.content === 'Second answer'), true)
  const older = again.runtime.transcript(first.id)
  assert.ok(older)
  assert.equal(older!.messages.some((item) => item.content === 'First answer'), true)
  assert.equal(older!.tools.some((item) => item.name === 'read_file'), true)
  const history = again.runtime.historyForWorkspace()
  assert.equal(history.length, 2)
  assert.equal(history.every((item) => item.id === first.id || item.id === second.id), true)
  again.db.close()
})

test('continuing after hydration does not duplicate prior messages into the new mission', async () => {
  const { root, dbPath, db } = harness()
  const prior = db.createAgentMission(root, 'Prior work')
  db.appendAgentMessage(prior.id, 'assistant', 'Already said')
  db.close()

  const again = reopen(dbPath, root)
  const events: AgentEvent[] = []
  let turns = 0
  const client: ModelClient = async (input) => {
    turns += 1
    const serialized = JSON.stringify(input.input)
    assert.match(serialized, /Prior conversation context|Prior mission context/)
    assert.match(serialized, /Already said/)
    if (turns === 1) {
      return completion('Continued')
    }
    return completion()
  }
  const runtime = new AgentRuntime({
    database: again.db,
    workspace: again.workspace,
    readApiKey: async () => 'bc_persist_secret',
    emit: (event) => events.push(event),
    client
  })
  const { missionId } = await runtime.submit('Continue please', prior.id)
  await runtime.finished()
  const transcript = again.db.agentTranscript(missionId)
  assert.ok(transcript)
  assert.equal(transcript!.mission.prompt, 'Continue please')
  assert.equal(transcript!.messages.filter((item) => item.content === 'Already said').length, 0)
  assert.notEqual(transcript!.mission.id, prior.id)
  again.db.close()
})

test('operation history, snapshots, and workspace associations survive restart', () => {
  const { root, dbPath, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'snap.txt'), 'payload')
  const operationId = applyDelete(root, db, workspace, 'snap.txt')
  const missionsBefore = db.listAgentMissionsForWorkspace(root)
  assert.ok(missionsBefore.length >= 1)
  db.close()

  const again = reopen(dbPath, root)
  const ops = again.db.listWorkspaceOperations({ workspacePath: root, kind: 'delete', status: 'applied' })
  assert.equal(ops.some((item) => item.id === operationId), true)
  const record = again.db.getAgentOperationRecord(operationId)
  assert.equal(record?.originalText, 'payload')
  assert.equal(again.db.agentMissionBelongsToWorkspace(ops[0]!.missionId, root), true)
  const listed = listFileOperations({
    database: again.db,
    workspacePath: root,
    argumentsText: JSON.stringify({ kind: 'delete', status: 'applied', scope: 'workspace' })
  })
  assert.match(listed.output, /"hasSnapshot":true/)
  again.db.close()
})

test('list_file_operations is available through the runtime tool path', async () => {
  const { root, db, workspace } = harness()
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'x')
  applyDelete(root, db, workspace, 'tracked.txt')
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
            call_id: 'list-ops',
            name: 'list_file_operations',
            arguments: JSON.stringify({ kind: 'delete', status: 'applied', scope: 'workspace' })
          }
        ],
        calls: [
          {
            callId: 'list-ops',
            name: 'list_file_operations',
            arguments: JSON.stringify({ kind: 'delete', status: 'applied', scope: 'workspace' })
          }
        ],
        text: '',
        requestId: 'req-list'
      }
    }
    return completion('Listed history')
  }
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => 'bc_persist_secret',
    emit: (event) => events.push(event),
    client
  })
  await runtime.submit('What did you delete?')
  await waitFor(() => events.some((event) => event.type === 'finished'))
  const tool = events.find(
    (event) =>
      event.type === 'tool' &&
      event.name === 'list_file_operations' &&
      (event.state === 'finished' || event.state === 'success')
  )
  assert.ok(tool && tool.type === 'tool')
  assert.match(tool.output ?? '', /tracked\.txt/)
  db.close()
})
