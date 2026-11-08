import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applyClaimedOperation, proposeMutation } from '../src/main/agent/mutations.ts'
import { runAgentLoop, type ModelClient } from '../src/main/agent/loop.ts'
import { hasRepeatedNarration } from '../src/renderer/src/conversation.ts'
import { AGENT_LIMITS } from '../src/shared/agent.ts'
import { executeTool } from '../src/main/agent/tools.ts'
import { MissionDatabase } from '../src/main/services/database.ts'
import { WorkspaceService } from '../src/main/services/workspace.ts'
import type { ProviderTurn } from '../src/main/agent/provider.ts'

const secret = 'bc_bulk_delete_secret'

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kern-bulk-'))
}

function turn(calls: Array<{ callId: string; name: string; arguments: string }>, text = ''): ProviderTurn {
  return {
    kind: 'completed',
    output: calls.map((call) => ({
      type: 'function_call',
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments
    })),
    calls,
    text,
    requestId: `req-${calls[0]?.callId ?? 'x'}`
  }
}

function seedExpoLikeWorkspace(root: string): void {
  const dirs = [
    'src',
    'src/app',
    'src/components',
    'src/components/ui',
    'src/constants',
    'src/hooks',
    'assets',
    'assets/images',
    'assets/images/tabIcons',
    'assets/expo.icon',
    'scripts',
    '.vscode',
    '.git',
    '.kern',
    'node_modules',
    'node_modules/left-pad'
  ]
  for (const dir of dirs) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}')
  fs.writeFileSync(path.join(root, 'app.json'), '{}')
  fs.writeFileSync(path.join(root, 'src/app/index.tsx'), 'export default function App(){return null}')
  fs.writeFileSync(path.join(root, 'src/components/ui/Button.tsx'), 'export const Button = () => null')
  fs.writeFileSync(path.join(root, 'assets/images/logo.png'), 'png')
  fs.writeFileSync(path.join(root, '.git/config'), 'gitdir')
  fs.writeFileSync(path.join(root, '.kern/state.json'), '{}')
  for (let i = 0; i < 50; i += 1) {
    fs.writeFileSync(path.join(root, 'node_modules/left-pad', `f${i}.js`), 'module.exports=1')
  }
}

test('recursive list_files returns nested tree in one call with regenerable single entries', () => {
  const root = temporaryDirectory()
  seedExpoLikeWorkspace(root)
  const started = Date.now()
  const listed = executeTool(root, 'demo', 'list_files', JSON.stringify({ path: '.', recursive: true }))
  assert.equal(listed.state, 'success', listed.output)
  const payload = JSON.parse(listed.output) as {
    recursive: boolean
    entries: Array<{ path: string; regenerable?: boolean; protected?: boolean }>
  }
  assert.equal(payload.recursive, true)
  assert.ok(payload.entries.some((entry) => entry.path === 'src/app'))
  assert.ok(payload.entries.some((entry) => entry.path === 'node_modules' && entry.regenerable))
  assert.ok(payload.entries.some((entry) => entry.path === '.git' && entry.protected))
  assert.equal(payload.entries.some((entry) => entry.path.startsWith('node_modules/')), false)
  assert.ok(Date.now() - started < 5_000)
})

test('search_files with "." or "**/*" returns the recursive tree', () => {
  const root = temporaryDirectory()
  seedExpoLikeWorkspace(root)
  for (const query of ['.', '*', '**/*']) {
    const result = executeTool(root, 'demo', 'search_files', JSON.stringify({ query, path: '.' }))
    assert.equal(result.state, 'success', `${query}: ${result.output}`)
    assert.match(result.output, /"recursive":true/)
    assert.match(result.output, /src\/app/)
  }
})

test('bulk delete proposal excludes protected paths, groups regenerable dirs, requires approval, restore is byte-identical', () => {
  const root = temporaryDirectory()
  seedExpoLikeWorkspace(root)
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const workspace = new WorkspaceService(db)
  workspace.open(root)
  const mission = db.createAgentMission(root, 'remove all')
  const proposed = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'del-bulk',
    workspacePath: root,
    name: 'delete_file',
    argumentsText: JSON.stringify({
      paths: ['src', 'assets', 'scripts', '.vscode', 'package.json', 'app.json', 'node_modules', '.git', '.kern'],
      recursive: true,
      explanation: 'Remove current project files'
    })
  })
  assert.equal(proposed.execution.state, 'awaiting_approval', proposed.execution.output)
  assert.ok(proposed.operation)
  assert.match(proposed.operation!.unifiedDiff, /Excluded \(not deleted\)/)
  assert.match(proposed.operation!.unifiedDiff, /\.git: Protected/)
  assert.match(proposed.operation!.unifiedDiff, /\.kern: Protected/)
  assert.match(proposed.operation!.unifiedDiff, /node_modules \(directory, regenerable\)/)
  assert.equal(proposed.operation!.unifiedDiff.includes('node_modules/left-pad'), false)
  assert.doesNotMatch(proposed.operation!.unifiedDiff, /Targets:[\s\S]*- \.git \(directory\)/)
  const before = fs.readFileSync(path.join(root, 'src/app/index.tsx'), 'utf8')
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
  assert.equal(fs.existsSync(path.join(root, 'src')), false)
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false)
  assert.equal(fs.existsSync(path.join(root, '.git')), true)
  assert.equal(fs.existsSync(path.join(root, '.kern')), true)
  const restored = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'restore',
    workspacePath: root,
    name: 'restore_file',
    argumentsText: JSON.stringify({
      operationId: proposed.operation!.id,
      explanation: 'Restore deleted project files'
    })
  })
  assert.ok(restored.operation)
  const restoreClaim = db.claimAgentOperation(mission.id, restored.operation!.id)
  assert.ok(restoreClaim)
  // restore_file auto-applies when not delete - check mutationRequiresApproval
  const restoreApplied = applyClaimedOperation({
    root,
    database: db,
    workspace,
    record: restoreClaim!,
    expectedFingerprint: restoreClaim!.contentFingerprint
  })
  assert.equal(restoreApplied.ok, true, restoreApplied.output)
  assert.equal(fs.readFileSync(path.join(root, 'src/app/index.tsx'), 'utf8'), before)
  db.close()
})

test('scripted happy path: recursive list then one delete proposal finishes in ≤4 turns', async () => {
  const root = temporaryDirectory()
  seedExpoLikeWorkspace(root)
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const workspace = new WorkspaceService(db)
  workspace.open(root)
  const mission = db.createAgentMission(root, 'remove all the current project files')
  let turns = 0
  let pendingId: string | null = null
  const client: ModelClient = async () => {
    turns += 1
    if (turns === 1) {
      return turn([
        {
          callId: 'list',
          name: 'list_files',
          arguments: JSON.stringify({ path: '.', recursive: true })
        }
      ])
    }
    if (turns === 2) {
      return turn([
        {
          callId: 'del',
          name: 'delete_file',
          arguments: JSON.stringify({
            paths: ['src', 'assets', 'scripts', '.vscode', 'package.json', 'app.json', 'node_modules'],
            recursive: true,
            explanation: 'Remove project files'
          })
        }
      ])
    }
    return turn([
      {
        callId: 'finish',
        name: 'submit_result',
        arguments: JSON.stringify({
          outcome: 'partially_completed',
          summary: 'Deletion proposed and awaiting approval.'
        })
      }
    ])
  }
  const result = await runAgentLoop({
    prompt: 'remove all the current project files',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret,
    client,
    executeTool: (name, argumentsText, cache) => executeTool(root, 'demo', name, argumentsText, cache),
    proposeMutation: (call) => {
      const proposed = proposeMutation({
        root,
        database: db,
        missionId: mission.id,
        callId: call.callId,
        workspacePath: root,
        name: call.name as 'delete_file',
        argumentsText: call.arguments
      })
      pendingId = proposed.operation?.id ?? null
      return { execution: proposed.execution, operationId: proposed.operation?.id ?? null }
    },
    waitForApprovals: async (ids) => {
      const id = ids[0]!
      const claimed = db.claimAgentOperation(mission.id, id)
      assert.ok(claimed)
      const applied = applyClaimedOperation({
        root,
        database: db,
        workspace,
        record: claimed!,
        expectedFingerprint: claimed!.contentFingerprint
      })
      return [{ callId: 'del', execution: { state: applied.ok ? 'success' : 'failed', output: applied.output } }]
    },
    listOperations: () => db.listAgentOperations(mission.id),
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: () => undefined
  })
  assert.ok(turns <= 4, `turns=${turns}`)
  assert.ok(pendingId)
  assert.equal(fs.existsSync(path.join(root, 'src')), false)
  assert.equal(fs.existsSync(path.join(root, '.git')), true)
  assert.ok(result.status === 'partially_completed' || result.status === 'completed' || result.status === 'blocked')
  db.close()
})

test('one-by-one listing triggers exploration-without-action stop with discovered tree', async () => {
  const root = temporaryDirectory()
  seedExpoLikeWorkspace(root)
  const dirs = ['.', 'src', 'src/app', 'src/components', 'src/components/ui', 'src/constants', 'src/hooks', 'assets', 'assets/images', 'scripts']
  let turns = 0
  const result = await runAgentLoop({
    prompt: 'remove all the current project files',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret,
    client: async () => {
      turns += 1
      const pathArg = dirs[(turns - 1) % dirs.length]!
      return turn(
        [{ callId: `list-${turns}`, name: 'list_files', arguments: JSON.stringify({ path: pathArg }) }],
        'gathering a complete file list…'
      )
    },
    executeTool: (name, argumentsText, cache) => executeTool(root, 'demo', name, argumentsText, cache),
    proposeMutation: () => ({
      execution: { state: 'rejected', output: JSON.stringify({ ok: false, outcome: 'rejected', error: 'unused' }) },
      operationId: null
    }),
    waitForApprovals: async () => [],
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: () => undefined
  })
  assert.match(result.summary ?? '', /exploration without action/i)
  assert.doesNotMatch(result.summary ?? '', /^Mission iteration limit reached/)
  assert.match(result.summary ?? '', /Discovered during exploration|Exploration covered|Next step/i)
  assert.ok(turns < AGENT_LIMITS.maxIterations)
})

test('delete safety rejects escape paths and workspace root', () => {
  const root = temporaryDirectory()
  fs.writeFileSync(path.join(root, 'keep.txt'), 'x')
  const outside = temporaryDirectory()
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope')
  fs.symlinkSync(outside, path.join(root, 'escape-link'))
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const mission = db.createAgentMission(root, 'unsafe')
  const cases = [
    { path: '..', explanation: 'escape' },
    { path: outside, explanation: 'absolute' },
    { path: '.', recursive: true, explanation: 'root' }
  ]
  for (const args of cases) {
    const proposed = proposeMutation({
      root,
      database: db,
      missionId: mission.id,
      callId: `bad-${String(args.path).slice(0, 24)}`,
      workspacePath: root,
      name: 'delete_file',
      argumentsText: JSON.stringify(args)
    })
    assert.equal(proposed.execution.state, 'rejected', JSON.stringify(args) + proposed.execution.output)
  }
  // Symlink pointing outside: deleting removes the link only, never the target.
  const linkDelete = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'escape-link',
    workspacePath: root,
    name: 'delete_file',
    argumentsText: JSON.stringify({ path: 'escape-link', explanation: 'remove symlink' })
  })
  assert.equal(linkDelete.execution.state, 'awaiting_approval', linkDelete.execution.output)
  const claimed = db.claimAgentOperation(mission.id, linkDelete.operation!.id)
  assert.ok(claimed)
  const workspace = new WorkspaceService(db)
  workspace.open(root)
  applyClaimedOperation({
    root,
    database: db,
    workspace,
    record: claimed!,
    expectedFingerprint: claimed!.contentFingerprint
  })
  assert.equal(fs.existsSync(path.join(root, 'escape-link')), false)
  assert.equal(fs.existsSync(path.join(outside, 'secret.txt')), true)
  db.close()
})

test('recursive list over a large tree truncates with counts under a time bound', () => {
  const root = temporaryDirectory()
  for (let i = 0; i < 120; i += 1) {
    const dir = path.join(root, `d${i}`)
    fs.mkdirSync(dir, { recursive: true })
    for (let j = 0; j < 30; j += 1) {
      fs.writeFileSync(path.join(dir, `f${j}.txt`), 'x')
    }
  }
  const started = Date.now()
  const listed = executeTool(root, 'demo', 'list_files', JSON.stringify({ path: '.', recursive: true }))
  assert.equal(listed.state, 'success', listed.output)
  const payload = JSON.parse(listed.output) as { truncated: boolean; entryCount: number }
  assert.equal(payload.truncated, true)
  assert.ok(payload.entryCount <= AGENT_LIMITS.maxRecursiveListEntries)
  assert.ok(Date.now() - started < 8_000)
})

test('read-only budget is separate from productive budget; argument errors counted separately', async () => {
  const root = temporaryDirectory()
  fs.writeFileSync(path.join(root, 'a.txt'), 'a')
  let turns = 0
  let sawBudgetHint = false
  const result = await runAgentLoop({
    prompt: 'inspect then stop',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret,
    client: async () => {
      turns += 1
      if (turns <= 3) {
        return turn([
          {
            callId: `bad-${turns}`,
            name: 'search_files',
            arguments: JSON.stringify({ nope: true })
          }
        ])
      }
      return turn([
        {
          callId: 'finish',
          name: 'submit_result',
          arguments: JSON.stringify({ outcome: 'blocked', summary: 'Stopped after argument errors.' })
        }
      ])
    },
    executeTool: (name, argumentsText, cache) => executeTool(root, 'demo', name, argumentsText, cache),
    proposeMutation: () => ({
      execution: { state: 'rejected', output: JSON.stringify({ ok: false, outcome: 'rejected', error: 'unused' }) },
      operationId: null
    }),
    waitForApprovals: async () => [],
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: (_call, execution) => {
      if (/unrecognized key|arguments were rejected/i.test(execution.output)) {
        sawBudgetHint = true
      }
    }
  })
  assert.equal(sawBudgetHint, true)
  assert.ok(result.status === 'failed' || result.status === 'blocked' || result.status === 'partially_completed')
})

test('narration dedupe drops repeated progress lines', () => {
  assert.equal(hasRepeatedNarration('gathering a complete file list', 'gathering a complete file list'), true)
  assert.equal(hasRepeatedNarration('gathering a complete file list', 'now proposing deletes'), false)
})
