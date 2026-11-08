import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { AgentRuntime } from '../src/main/agent/runtime.ts'
import { applyClaimedOperation, proposeMutation } from '../src/main/agent/mutations.ts'
import { MissionDatabase } from '../src/main/services/database.ts'
import { WorkspaceService } from '../src/main/services/workspace.ts'

const userData = path.join(process.env.HOME ?? '', 'Library/Application Support/kern')
const dbPath = path.join(userData, 'kern.sqlite')
const deleteId = '43ea4ec2-799a-4879-8293-65c43540140a'

const probe = new MissionDatabase(dbPath)
const probeWorkspace = new WorkspaceService(probe)
const workspaceInfo = probeWorkspace.restore()
assert.ok(workspaceInfo, 'workspace must restore from settings')
assert.match(workspaceInfo.path, /Ai-Agent/)

const beforeMissions = probe.listAgentMissionsForWorkspace(workspaceInfo.path, 50)
const beforeMessages = beforeMissions.reduce((sum, mission) => {
  const transcript = probe.agentTranscript(mission.id)
  return sum + (transcript?.messages.length ?? 0)
}, 0)
const record = probe.getAgentOperationRecord(deleteId)
assert.ok(record, 'delete operation must still exist')
assert.equal(record.status, 'applied')
assert.equal(record.path, 'Nabil-test.txt')
assert.equal(record.originalText, 'Edits is working\n')
assert.equal(fs.existsSync(path.join(workspaceInfo.path, 'Nabil-test.txt')), false)
probe.close()

// Simulate application restart: reopen DB, interrupt active missions, hydrate transcript.
const database = new MissionDatabase(dbPath)
const workspace = new WorkspaceService(database)
const restoredWorkspace = workspace.restore()
assert.ok(restoredWorkspace)
const runtime = new AgentRuntime({
  database,
  workspace,
  readApiKey: async () => null,
  emit: () => undefined
})
assert.equal(runtime.current(), null)
const hydrated = runtime.hydrate()
assert.ok(hydrated, 'hydrate must return the latest workspace mission transcript')
const history = runtime.historyForWorkspace(20)
assert.ok(history.length >= 1, 'mission history must survive restart')
assert.ok(history.some((item) => item.id === hydrated.mission.id))

const ops = database.listWorkspaceOperations({
  workspacePath: restoredWorkspace.path,
  path: 'Nabil-test.txt',
  kind: 'delete',
  status: 'applied'
})
assert.equal(ops.some((item) => item.id === deleteId), true)

const mission = database.createAgentMission(restoredWorkspace.path, 'Restore the file you deleted earlier.')
const proposed = proposeMutation({
  root: restoredWorkspace.path,
  database,
  missionId: mission.id,
  callId: 'live-restore',
  workspacePath: restoredWorkspace.path,
  name: 'restore_file',
  argumentsText: JSON.stringify({
    operationId: deleteId,
    explanation: 'Restore Nabil-test.txt from persisted deletion snapshot'
  })
})
assert.ok(proposed.operation, proposed.execution.output)
assert.equal(proposed.operation.kind, 'restore')
assert.equal(proposed.operation.sourceOperationId, deleteId)
const claimed = database.claimAgentOperation(mission.id, proposed.operation.id)
assert.ok(claimed)
const applied = applyClaimedOperation({
  root: restoredWorkspace.path,
  database,
  workspace,
  record: claimed,
  expectedFingerprint: claimed.contentFingerprint
})
assert.equal(applied.ok, true, applied.output)
assert.match(applied.output, /"restored":true/)

const target = path.join(restoredWorkspace.path, 'Nabil-test.txt')
assert.equal(fs.existsSync(target), true)
assert.equal(fs.readFileSync(target, 'utf8'), 'Edits is working\n')

const afterMissions = database.listAgentMissionsForWorkspace(restoredWorkspace.path, 50)
assert.ok(afterMissions.length >= beforeMissions.length)
const afterMessages = afterMissions.reduce((sum, item) => {
  const transcript = database.agentTranscript(item.id)
  return sum + (transcript?.messages.length ?? 0)
}, 0)
assert.ok(afterMessages >= beforeMessages)

console.log(
  JSON.stringify(
    {
      ok: true,
      workspace: restoredWorkspace.path,
      hydratedMissionId: hydrated.mission.id,
      hydratedPrompt: hydrated.mission.prompt.slice(0, 80),
      historyCount: history.length,
      restoredPath: 'Nabil-test.txt',
      restoredBytes: fs.statSync(target).size,
      sourceOperationId: deleteId,
      restoreOperationId: proposed.operation.id
    },
    null,
    2
  )
)
database.close()
