import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runBrokerCommand } from '../src/main/agent/commands.ts'
import { executeTool } from '../src/main/agent/tools.ts'
import { MissionDatabase } from '../src/main/services/database.ts'
import { resolveInside, workspaceRoot } from '../src/main/security/pathJail.ts'

async function assertPathIdentity(workspacePath: string): Promise<void> {
  const resolvedWorkspace = workspaceRoot(workspacePath)
  fs.mkdirSync(path.join(resolvedWorkspace, 'nested', 'deep'), { recursive: true })
  fs.writeFileSync(
    path.join(resolvedWorkspace, 'nested', 'deep', 'probe.mjs'),
    'import fs from "node:fs"; fs.writeFileSync("cwd.txt", process.cwd());'
  )
  const db = new MissionDatabase(path.join(resolvedWorkspace, 'kern.sqlite'))
  const mission = db.createAgentMission(workspacePath, 'path identity')

  const listedRoot = executeTool(workspacePath, 'demo', 'list_files', JSON.stringify({ path: '.' }))
  assert.equal(listedRoot.state, 'success', listedRoot.output)
  const listedNested = executeTool(workspacePath, 'demo', 'list_files', JSON.stringify({ path: 'nested/deep' }))
  assert.equal(listedNested.state, 'success', listedNested.output)

  const listRootPath = resolveInside(workspacePath, '.')
  const listNestedPath = resolveInside(workspacePath, 'nested/deep')
  assert.equal(listRootPath, resolvedWorkspace)
  assert.equal(listNestedPath, path.join(resolvedWorkspace, 'nested', 'deep'))

  const atRoot = await runBrokerCommand({
    root: workspacePath,
    database: db,
    missionId: mission.id,
    callId: 'root-cwd',
    argumentsText: JSON.stringify({
      command: 'npm',
      args: ['--version'],
      working_directory: '.',
      explanation: 'root cwd probe',
      timeout_ms: 30_000
    }),
    signal: new AbortController().signal
  })
  assert.equal(atRoot.state, 'success', atRoot.output)
  const rootPayload = JSON.parse(atRoot.output) as {
    workingDirectory: string
    cwd: string
    workspaceRoot: string
  }
  assert.equal(rootPayload.workingDirectory, '.')
  assert.equal(fs.realpathSync(rootPayload.cwd), resolvedWorkspace)
  assert.equal(fs.realpathSync(rootPayload.workspaceRoot), resolvedWorkspace)
  assert.equal(fs.realpathSync(rootPayload.workspaceRoot), listRootPath)

  const nested = await runBrokerCommand({
    root: workspacePath,
    database: db,
    missionId: mission.id,
    callId: 'nested-cwd',
    argumentsText: JSON.stringify({
      command: 'node',
      args: ['probe.mjs'],
      working_directory: 'nested/deep',
      explanation: 'nested cwd probe',
      timeout_ms: 30_000
    }),
    signal: new AbortController().signal
  })
  assert.equal(nested.state, 'success', nested.output)
  const nestedPayload = JSON.parse(nested.output) as {
    workingDirectory: string
    cwd: string
    workspaceRoot: string
  }
  assert.equal(nestedPayload.workingDirectory, 'nested/deep')
  assert.equal(fs.realpathSync(nestedPayload.cwd), listNestedPath)
  assert.equal(fs.realpathSync(nestedPayload.workspaceRoot), resolvedWorkspace)
  assert.equal(
    fs.readFileSync(path.join(resolvedWorkspace, 'nested', 'deep', 'cwd.txt'), 'utf8'),
    listNestedPath
  )
  db.close()
}

test('run_command cwd, list_files root, and command workspaceRoot share one resolved path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-path-id-'))
  await assertPathIdentity(root)
})

test('path identity holds when the workspace is opened through a symlink', async () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-path-real-'))
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-path-link-'))
  const link = path.join(linkParent, 'workspace-link')
  fs.symlinkSync(real, link, 'dir')
  await assertPathIdentity(link)
})
