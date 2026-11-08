import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runBrokerCommand } from '../src/main/agent/commands.ts'
import { runAgentLoop } from '../src/main/agent/loop.ts'
import { executeTool } from '../src/main/agent/tools.ts'
import { MissionDatabase } from '../src/main/services/database.ts'
import { isAlive } from '../src/main/services/processGroup.mjs'
import { toolDetail } from '../src/renderer/src/conversation.ts'
import type { ProviderTurn } from '../src/main/agent/provider.ts'

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kern-cmd-'))
}

function harness(): { root: string; db: MissionDatabase; missionId: string } {
  const root = temporaryDirectory()
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const mission = db.createAgentMission(root, 'commands')
  return { root, db, missionId: mission.id }
}

function request(command: string, args: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    command,
    args,
    working_directory: '.',
    explanation: 'test command',
    timeout_ms: 15_000,
    ...extra
  })
}

test('run_command cannot bypass the broker through executeTool', () => {
  const root = temporaryDirectory()
  const result = executeTool(root, 'demo', 'run_command', request('rm', ['-rf', '.']))
  assert.equal(result.state, 'rejected')
  assert.match(result.output, /not available/)
})

test('git, shells, inline eval, and paths outside the workspace are blocked', async () => {
  const { root, db, missionId } = harness()
  const outside = temporaryDirectory()
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'hidden')
  fs.symlinkSync(outside, path.join(root, 'escape-link'))
  const cases = [
    request('git', ['push']),
    request('bash', ['-c', 'echo hi']),
    request('rm', ['-rf', '.']),
    request('node', ['-e', 'process.exit(0)']),
    request('/bin/echo', ['hi']),
    request('node', ['script.js'], { working_directory: 'escape-link' }),
    request('node', ['script.js'], { working_directory: '../outside' })
  ]
  for (const argumentsText of cases) {
    const result = await runBrokerCommand({
      root,
      database: db,
      missionId,
      callId: `blocked-${cases.indexOf(argumentsText)}`,
      argumentsText,
      signal: new AbortController().signal
    })
    assert.equal(result.state, 'rejected', argumentsText)
    assert.equal(result.output.includes('hidden'), false)
  }
  assert.equal(fs.existsSync(path.join(outside, 'script.js')), false)
  db.close()
})

test('a workspace node script runs, records the exit code, and hides parent secrets', async () => {
  const { root, db, missionId } = harness()
  const sentinel = 'kern-secret-should-not-leak'
  const previous = process.env.KERN_TEST_SECRET
  process.env.KERN_TEST_SECRET = sentinel
  fs.writeFileSync(
    path.join(root, 'probe.js'),
    'console.log(JSON.stringify({ secret: process.env.KERN_TEST_SECRET || null, home: process.env.HOME || null }))\n'
  )
  try {
    const result = await runBrokerCommand({
      root,
      database: db,
      missionId,
      callId: 'probe',
      argumentsText: request('node', ['probe.js']),
      signal: new AbortController().signal
    })
    assert.equal(result.state, 'success')
    const payload = JSON.parse(result.output) as { status: string; exitCode: number; stdout: string }
    assert.equal(payload.status, 'completed')
    assert.equal(payload.exitCode, 0)
    assert.equal(payload.stdout.includes(sentinel), false)
    const row = db.listAgentCommands(missionId)[0]
    assert.equal(row?.status, 'completed')
    assert.equal(row?.exitCode, 0)
    assert.equal(row?.stdout?.includes(sentinel), false)
  } finally {
    if (previous === undefined) {
      delete process.env.KERN_TEST_SECRET
    } else {
      process.env.KERN_TEST_SECRET = previous
    }
    db.close()
  }
})

test('failed commands keep the real exit code', async () => {
  const { root, db, missionId } = harness()
  fs.writeFileSync(path.join(root, 'fail.js'), 'process.exit(3)\n')
  const result = await runBrokerCommand({
    root,
    database: db,
    missionId,
    callId: 'fail',
    argumentsText: request('node', ['fail.js']),
    signal: new AbortController().signal
  })
  assert.equal(result.state, 'failed')
  const payload = JSON.parse(result.output) as { status: string; exitCode: number }
  assert.equal(payload.status, 'failed')
  assert.equal(payload.exitCode, 3)
  db.close()
})

test('timeouts kill the process tree', async () => {
  const { root, db, missionId } = harness()
  fs.writeFileSync(path.join(root, 'sleep.js'), 'setTimeout(() => {}, 30000)\n')
  fs.writeFileSync(
    path.join(root, 'parent.js'),
    `const { spawn } = require('node:child_process')
const fs = require('node:fs')
const child = spawn(process.execPath, [process.argv[2]], { stdio: 'ignore' })
fs.writeFileSync(process.argv[3], String(child.pid))
setTimeout(() => {}, 30000)
`
  )
  const result = await runBrokerCommand({
    root,
    database: db,
    missionId,
    callId: 'timeout',
    argumentsText: request('node', ['parent.js', 'sleep.js', 'child.pid'], { timeout_ms: 3_000 }),
    signal: new AbortController().signal
  })
  const payload = JSON.parse(result.output) as { status: string }
  assert.equal(payload.status, 'timed_out')
  assert.equal(result.state, 'failed')
  const pidText = fs.readFileSync(path.join(root, 'child.pid'), 'utf8').trim()
  const childPid = Number(pidText)
  await new Promise((resolve) => setTimeout(resolve, 50))
  if (Number.isInteger(childPid) && childPid > 0) {
    assert.equal(isAlive(childPid), false)
  }
  db.close()
})

test('cancellation kills the running command', async () => {
  const { root, db, missionId } = harness()
  fs.writeFileSync(path.join(root, 'sleep.js'), 'setTimeout(() => {}, 30000)\n')
  const controller = new AbortController()
  const pending = runBrokerCommand({
    root,
    database: db,
    missionId,
    callId: 'cancel',
    argumentsText: request('node', ['sleep.js'], { timeout_ms: 30_000 }),
    signal: controller.signal
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  controller.abort()
  const result = await pending
  assert.equal(result.state, 'cancelled')
  const payload = JSON.parse(result.output) as { status: string }
  assert.equal(payload.status, 'cancelled')
  assert.equal(db.listAgentCommands(missionId)[0]?.status, 'cancelled')
  db.close()
})

test('command output is bounded', async () => {
  const { root, db, missionId } = harness()
  fs.writeFileSync(path.join(root, 'big.js'), "process.stdout.write('x'.repeat(20000))\n")
  const result = await runBrokerCommand({
    root,
    database: db,
    missionId,
    callId: 'big',
    argumentsText: request('node', ['big.js']),
    signal: new AbortController().signal
  })
  const payload = JSON.parse(result.output) as { stdout: string; truncated: boolean; status: string }
  assert.equal(payload.status, 'completed')
  assert.equal(payload.truncated, true)
  assert.match(payload.stdout, /truncated/)
  assert.ok(payload.stdout.length < 20_000)
  db.close()
})

test('a second command waits until the workspace command finishes', async () => {
  const { root, db, missionId } = harness()
  fs.writeFileSync(path.join(root, 'sleep.js'), 'setTimeout(() => {}, 30000)\n')
  fs.writeFileSync(path.join(root, 'ok.js'), 'console.log("ok")\n')
  const controller = new AbortController()
  const first = runBrokerCommand({
    root,
    database: db,
    missionId,
    callId: 'first',
    argumentsText: request('node', ['sleep.js'], { timeout_ms: 30_000 }),
    signal: controller.signal
  })
  await waitFor(() => db.listAgentCommands(missionId).some((command) => command.status === 'running'))
  const second = await runBrokerCommand({
    root,
    database: db,
    missionId,
    callId: 'second',
    argumentsText: request('node', ['ok.js']),
    signal: new AbortController().signal
  })
  assert.equal(second.state, 'rejected')
  assert.match(second.output, /already running/)
  controller.abort()
  await first
  db.close()
})

test('a local fixture command generates a multi-file project and the loop sees the result', async () => {
  const { root, db, missionId } = harness()
  fs.writeFileSync(
    path.join(root, 'generate.js'),
    `const fs = require('node:fs')
const path = require('node:path')
fs.mkdirSync(path.join(process.cwd(), 'app'), { recursive: true })
fs.writeFileSync(path.join(process.cwd(), 'package.json'), '{"name":"fixture-expo","dependencies":{"expo":"fixture"}}\\n')
fs.writeFileSync(path.join(process.cwd(), 'app.json'), '{"expo":{"name":"Fixture","slug":"fixture"}}\\n')
fs.writeFileSync(path.join(process.cwd(), 'app/index.tsx'), 'export default function App(){return null}\\n')
fs.writeFileSync(path.join(process.cwd(), 'app/_layout.tsx'), 'export default function Layout(){return null}\\n')
`
  )
  let sawExit = false
  let turns = 0
  const result = await runAgentLoop({
    prompt: 'Generate a fixture project',
    workspaceName: 'demo',
    signal: new AbortController().signal,
    secret: 'unused-secret',
    client: async (input) => {
      turns += 1
      if (JSON.stringify(input.input).includes('exitCode\\":0')) {
        sawExit = true
      }
      if (turns === 1) {
        const argumentsText = request('node', ['generate.js'])
        return {
          kind: 'completed',
          output: [{ type: 'function_call', call_id: 'gen', name: 'run_command', arguments: argumentsText }],
          calls: [{ callId: 'gen', name: 'run_command', arguments: argumentsText }],
          text: '',
          requestId: null
        }
      }
      return completion('Generated the fixture project files. Dependencies were not installed by this fixture.')
    },
    executeTool: (name, argumentsText, cache) => executeTool(root, 'demo', name, argumentsText, cache),
    proposeMutation: () => ({
      execution: { state: 'rejected', output: JSON.stringify({ ok: false, outcome: 'rejected', error: 'unused' }) },
      operationId: null
    }),
    runCommand: (call) =>
      runBrokerCommand({
        root,
        database: db,
        missionId,
        callId: call.callId,
        argumentsText: call.arguments,
        signal: new AbortController().signal
      }),
    waitForApprovals: async () => [],
    listOperations: () => db.listAgentOperations(missionId),
    onStatus: () => undefined,
    onText: () => undefined,
    onTool: () => undefined
  })
  assert.equal(sawExit, true)
  assert.equal(result.status, 'completed')
  assert.match(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), /fixture-expo/)
  assert.equal(fs.existsSync(path.join(root, 'app', '_layout.tsx')), true)
  assert.equal(fs.existsSync(path.join(root, 'app', 'index.tsx')), true)
  assert.equal(db.listAgentCommands(missionId)[0]?.status, 'completed')
  assert.equal(toolDetail(request('node', ['generate.js'])), 'node generate.js')
  db.close()
})

test('official Expo generator runs only when the package registry is reachable', { timeout: 240_000 }, async (t) => {
  const online = await registryReachable()
  if (!online) {
    t.diagnostic(
      'External network is unavailable. Official Expo generation and dependency installation were not executed. The local fixture command test covers the broker.'
    )
    return
  }
  const { root, db, missionId } = harness()
  const created = await runBrokerCommand({
    root,
    database: db,
    missionId,
    callId: 'expo-create',
    argumentsText: request(
      'npx',
      ['--yes', 'create-expo-app@latest', 'expo-app', '--template', 'blank-typescript'],
      { timeout_ms: 180_000, explanation: 'Generate an Expo app' }
    ),
    signal: new AbortController().signal
  })
  const createdPayload = JSON.parse(created.output) as { status: string; stderr: string; stdout: string; error: string | null }
  if (createdPayload.status !== 'completed') {
    const detail = `${createdPayload.error ?? ''}\n${createdPayload.stderr}\n${createdPayload.stdout}`
    if (
      /ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|getaddrinfo|403|401|ECONNRESET|Cannot read properties of null|npm error/i.test(
        detail
      )
    ) {
      t.diagnostic(
        `Expo generator failed outside KERN control (network/registry/npm). Broker still returned full stderr. Local fixture coverage remains. ${createdPayload.error ?? ''}`
      )
      db.close()
      return
    }
    assert.fail(detail.slice(0, 1_000))
  }
  const appRoot = path.join(root, 'expo-app')
  assert.equal(fs.existsSync(path.join(appRoot, 'package.json')), true)
  assert.match(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'), /expo/)
  const installed = await runBrokerCommand({
    root,
    database: db,
    missionId,
    callId: 'expo-install',
    argumentsText: request('npm', ['install'], {
      timeout_ms: 180_000,
      working_directory: 'expo-app',
      explanation: 'Install Expo dependencies'
    }),
    signal: new AbortController().signal
  })
  const installPayload = JSON.parse(installed.output) as { status: string; stderr: string; error: string | null }
  if (installPayload.status !== 'completed') {
    const detail = `${installPayload.error ?? ''}\n${installPayload.stderr}`
    if (/ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|getaddrinfo|ECONNRESET|Cannot read properties of null|npm error/i.test(detail)) {
      t.diagnostic(
        'Dependency installation failed outside KERN control (network/registry/npm). Generated Expo files remain; node_modules was not installed. Full stderr was returned by the broker.'
      )
      db.close()
      return
    }
    assert.fail(detail.slice(0, 1_000))
  }
  assert.equal(fs.existsSync(path.join(appRoot, 'node_modules', 'expo')), true)
  db.close()
})

function completion(summary: string): ProviderTurn {
  const argumentsText = JSON.stringify({ outcome: 'completed', summary })
  return {
    kind: 'completed',
    output: [{ type: 'function_call', call_id: 'finish', name: 'submit_result', arguments: argumentsText }],
    calls: [{ callId: 'finish', name: 'submit_result', arguments: argumentsText }],
    text: '',
    requestId: null
  }
}

function registryReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: 'registry.npmjs.org', port: 443, timeout: 2_500 })
    const done = (value: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
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
