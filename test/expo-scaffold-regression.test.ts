import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runBrokerCommand } from '../src/main/agent/commands.ts'
import { runAgentLoop, type ModelClient } from '../src/main/agent/loop.ts'
import {
  commandFailureHints,
  honestSummary,
  resolveClaimedCompletion,
  snapshotFromOperations
} from '../src/main/agent/progress.ts'
import { executeTool, MODEL_TOOLS } from '../src/main/agent/tools.ts'
import type { ProviderTurn } from '../src/main/agent/provider.ts'
import { MissionDatabase } from '../src/main/services/database.ts'

const secret = 'bc_expo_regression_secret'

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kern-expo-'))
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
    requestId: `req-${calls[0]?.callId ?? 'empty'}`
  }
}

test('after run_command creates files, the next list_files sees them', async () => {
  const root = temporaryDirectory()
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const mission = db.createAgentMission(root, 'list after command')
  fs.writeFileSync(
    path.join(root, 'write-scaffold.mjs'),
    'import fs from "node:fs"; fs.writeFileSync("package.json", JSON.stringify({ name: "demo", private: true }));'
  )
  const created = await runBrokerCommand({
    root,
    database: db,
    missionId: mission.id,
    callId: 'scaffold',
    argumentsText: JSON.stringify({
      command: 'node',
      args: ['write-scaffold.mjs'],
      working_directory: '.',
      explanation: 'Write package.json via script',
      timeout_ms: 30_000
    }),
    signal: new AbortController().signal
  })
  assert.equal(created.state, 'success', created.output)
  assert.equal(fs.existsSync(path.join(root, 'package.json')), true)
  const listed = executeTool(root, 'demo', 'list_files', JSON.stringify({ path: '.' }))
  assert.equal(listed.state, 'success', listed.output)
  assert.match(listed.output, /package\.json/)
  db.close()
})

test('scripted Expo-like mission: schema aliases, real stderr, honest unverified report, no loop', async () => {
  const root = temporaryDirectory()
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const mission = db.createAgentMission(root, 'generate a fresh new react native expo project')
  const toolOutputs: string[] = []
  const schemasSeen: unknown[] = []
  let turns = 0
  let installAttempts = 0

  const client: ModelClient = async (input) => {
    schemasSeen.push(input.tools)
    turns += 1
    if (turns === 1) {
      return turn([{ callId: 'list1', name: 'list_files', arguments: JSON.stringify({ path: '.' }) }], 'Checking the workspace…')
    }
    if (turns === 2) {
      // Historical failure mode: pattern/path instead of query.
      return turn([
        {
          callId: 'search1',
          name: 'search_files',
          arguments: JSON.stringify({ pattern: 'package.json', path: '.' })
        }
      ])
    }
    if (turns === 3) {
      // Historical failure mode: camelCase cwd alias.
      return turn([
        {
          callId: 'scaffold',
          name: 'run_command',
          arguments: JSON.stringify({
            command: 'npx',
            args: ['create-expo-app@latest', '.', '--template', 'default', '--yes'],
            workingDirectory: '.',
            explanation: 'Scaffold Expo',
            timeout_ms: 120_000
          })
        }
      ])
    }
    if (turns === 4) {
      return turn([{ callId: 'list2', name: 'list_files', arguments: JSON.stringify({ path: '.' }) }])
    }
    if (turns === 5) {
      installAttempts += 1
      return turn([
        {
          callId: 'install',
          name: 'run_command',
          arguments: JSON.stringify({
            command: 'npm',
            args: ['install'],
            working_directory: '.',
            explanation: 'Install dependencies',
            timeout_ms: 180_000
          })
        }
      ])
    }
    if (turns === 6) {
      // Repeat identical list after failure — loop detector should reject on second identical after first success was stored.
      return turn([{ callId: 'list3', name: 'list_files', arguments: JSON.stringify({ path: '.' }) }])
    }
    return turn([
      {
        callId: 'finish',
        name: 'submit_result',
        arguments: JSON.stringify({
          outcome: 'completed',
          summary: 'Expo scaffold ready and verified.'
        })
      }
    ])
  }

  const result = await runAgentLoop({
    prompt: 'generate a fresh new react native expo project',
    workspaceName: 'empty-demo',
    signal: new AbortController().signal,
    secret,
    client,
    executeTool: (name, argumentsText, cache) => executeTool(root, 'empty-demo', name, argumentsText, cache),
    runCommand: async (call) => {
      const args = JSON.parse(call.arguments) as {
        command: string
        args: string[]
        workingDirectory?: string
        working_directory?: string
      }
      if (call.name !== 'run_command') {
        return { state: 'rejected', output: JSON.stringify({ ok: false, outcome: 'rejected', error: 'not a command' }) }
      }
      if (args.command === 'npx' && args.args.includes('create-expo-app@latest')) {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'expo-demo', private: true }))
        fs.writeFileSync(path.join(root, 'app.json'), '{}')
        fs.mkdirSync(path.join(root, 'app'), { recursive: true })
        fs.writeFileSync(path.join(root, 'app/index.tsx'), 'export default function App(){return null}')
        return {
          state: 'success',
          output: JSON.stringify({
            ok: true,
            outcome: 'success',
            status: 'completed',
            command: 'npx',
            args: args.args,
            workingDirectory: args.working_directory ?? args.workingDirectory ?? '.',
            workspaceRoot: root,
            exitCode: 0,
            stdout: '✔ Created project',
            stderr: '',
            truncated: false,
            durationMs: 12,
            warnings: [],
            error: null
          })
        }
      }
      if (args.command === 'npm' && args.args[0] === 'install') {
        const stderr =
          'npm error code ECONNRESET\nnpm error network read ECONNRESET\nnpm error network This is a network-style error'
        return {
          state: 'failed',
          output: JSON.stringify({
            ok: false,
            outcome: 'failed',
            status: 'failed',
            command: 'npm',
            args: ['install'],
            workingDirectory: '.',
            workspaceRoot: root,
            exitCode: 1,
            stdout: '',
            stderr,
            truncated: false,
            durationMs: 40,
            warnings: ['Network/registry error text appears in command output.'],
            error: 'Command exited with code 1.',
            note: 'Exit code alone is not enough. Read stderr/warnings before claiming install or scaffold success.'
          })
        }
      }
      return {
        state: 'rejected',
        output: JSON.stringify({ ok: false, outcome: 'rejected', error: `unexpected command ${args.command}` })
      }
    },
    proposeMutation: () => ({
      execution: { state: 'rejected', output: JSON.stringify({ ok: false, outcome: 'rejected', error: 'unused' }) },
      operationId: null
    }),
    waitForApprovals: async () => [],
    listOperations: () => db.listAgentOperations(mission.id),
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: (_call, execution) => {
      toolOutputs.push(execution.output)
    }
  })

  assert.ok(turns <= 8, `burned too many turns: ${turns}`)
  assert.equal(installAttempts, 1)
  assert.equal(JSON.stringify(schemasSeen[0]), JSON.stringify([...MODEL_TOOLS]))
  assert.equal(toolOutputs.some((output) => output.includes('ECONNRESET')), true)
  assert.equal(toolOutputs.some((output) => /unrecognized key pattern/i.test(output)), false)
  // Chat-facing summary is short prose — ledger lives in Trace via reportLedger.
  assert.doesNotMatch(result.summary ?? '', /Discovered during exploration/)
  assert.doesNotMatch(result.summary ?? '', /\bVerified by read after apply\b/i)
  assert.doesNotMatch(result.summary ?? '', /\bVerified:\b/)
  assert.match(result.summary ?? '', /fail|partial|dependenc|install|unverified|Command|verification|stop|error/i)
  assert.notEqual(result.status, 'completed')
  assert.ok(result.status === 'partially_completed' || result.status === 'blocked' || result.status === 'failed')
  assert.equal(fs.existsSync(path.join(root, 'package.json')), true)
  db.close()
})

test('failed package-manager commands include real stderr and exact next commands in the report', () => {
  const hints = commandFailureHints(
    'npm install',
    'npm error code ENOSPC\nnpm error ENOSPC: no space left on device, write',
    'Command exited with code 1.'
  )
  const summary = honestSummary({
    proposed: [],
    approvedOrApplied: [],
    applied: [],
    failed: [],
    rejected: [],
    awaitingApproval: [],
    pendingDeletions: [],
    cancelled: [],
    verifiedReads: [],
    commands: [{ label: 'npm install', status: 'failed', ...hints }]
  })
  assert.match(summary, /ENOSPC/)
  assert.match(summary, /npm cache verify/)
  assert.match(summary, /npm install/)
  assert.match(summary, /upgrade npm|npm@latest/)
})

test('report cannot mark the same file failed and write-confirmed', () => {
  const snapshot = {
    ...snapshotFromOperations([
      {
        id: '1',
        missionId: 'm',
        callId: 'c',
        kind: 'create',
        path: 'package.json',
        toPath: null,
        explanation: 'x',
        status: 'failed',
        unifiedDiff: '',
        destructive: false,
        error: 'ENOENT',
        contentFingerprint: 'a',
        sourceOperationId: null,
        createdAt: '',
        resolvedAt: null
      }
    ]),
    verifiedReads: ['package.json'],
    commands: [{ label: 'npm install', status: 'failed' }]
  }
  const summary = honestSummary(snapshot)
  assert.match(summary, /Failed operations: package\.json/)
  assert.doesNotMatch(summary, /Write confirmed by read: package\.json/)
  assert.doesNotMatch(summary, /Write confirmed by read: \(none\)/)
  const resolved = resolveClaimedCompletion({ outcome: 'completed', summary: 'Verified package.json' }, snapshot)
  assert.notEqual(resolved.status, 'completed')
  assert.doesNotMatch(resolved.summary, /\bVerified by read after apply\b/)
  assert.doesNotMatch(resolved.summary, /Proposed this mission/)
})
