import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runBrokerCommand } from '../src/main/agent/commands.ts'
import { listFileOperations, proposeMutation } from '../src/main/agent/mutations.ts'
import {
  MODEL_TOOLS,
  TOOL_ARGUMENT_EXAMPLES,
  TOOL_PARAMETER_SCHEMAS,
  executeTool,
  parseCompletion
} from '../src/main/agent/tools.ts'
import { MissionDatabase } from '../src/main/services/database.ts'

function withUnknownKey(example: Record<string, unknown>): string {
  return JSON.stringify({ ...example, __unknown_kern_key: true })
}

function assertActionableRejection(output: string, toolName: string): void {
  assert.match(output, /unrecognized key __unknown_kern_key|unrecognized key/, `${toolName}: ${output}`)
  assert.match(output, /Example:/, `${toolName}: missing example in ${output}`)
  const schema = TOOL_PARAMETER_SCHEMAS[toolName as keyof typeof TOOL_PARAMETER_SCHEMAS]
  const expectedField = Object.keys(schema.properties)[0]
  if (expectedField) {
    assert.match(output, new RegExp(expectedField), `${toolName}: expected field ${expectedField}`)
  }
}

test('provider tool parameters are identical to the shared schema objects', () => {
  for (const tool of MODEL_TOOLS) {
    const name = tool.name as keyof typeof TOOL_PARAMETER_SCHEMAS
    assert.equal(JSON.stringify(tool.parameters), JSON.stringify(TOOL_PARAMETER_SCHEMAS[name]), name)
  }
})

test('documented examples validate for inspection and command tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-schema-'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}')
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const mission = db.createAgentMission(root, 'schema examples')

  for (const name of ['list_files', 'read_file', 'search_files', 'get_workspace_info'] as const) {
    const result = executeTool(root, 'demo', name, JSON.stringify(TOOL_ARGUMENT_EXAMPLES[name]))
    assert.equal(result.state, 'success', `${name}: ${result.output}`)
  }

  const listed = listFileOperations({
    database: db,
    workspacePath: root,
    missionId: mission.id,
    argumentsText: JSON.stringify(TOOL_ARGUMENT_EXAMPLES.list_file_operations)
  })
  assert.equal(listed.state, 'success', listed.output)

  const command = await runBrokerCommand({
    root,
    database: db,
    missionId: mission.id,
    callId: 'schema-cmd',
    argumentsText: JSON.stringify(TOOL_ARGUMENT_EXAMPLES.run_command),
    signal: new AbortController().signal
  })
  assert.equal(command.state, 'success', command.output)

  const created = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'schema-create',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify(TOOL_ARGUMENT_EXAMPLES.create_file)
  })
  assert.equal(created.execution.state, 'success', created.execution.output)
  db.close()
})

test('search_files accepts pattern/path aliases and rejects undocumented keys with an example', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-search-'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}')
  const ok = executeTool(root, 'demo', 'search_files', JSON.stringify({ pattern: 'package', path: '.' }))
  assert.equal(ok.state, 'success', ok.output)
  const bad = executeTool(root, 'demo', 'search_files', JSON.stringify({ pattern: '*', path: '.', extra: true }))
  assert.equal(bad.state, 'rejected')
  assert.match(bad.output, /unrecognized key extra/)
  assert.match(bad.output, /Example:/)
  assert.match(bad.output, /query/)
})

test('every registered tool rejects unknown argument keys with an actionable message', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-unknown-key-'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}')
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello')
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const mission = db.createAgentMission(root, 'unknown keys')

  for (const tool of MODEL_TOOLS) {
    const name = tool.name as keyof typeof TOOL_PARAMETER_SCHEMAS
    const payload = withUnknownKey({ ...TOOL_ARGUMENT_EXAMPLES[name] })
    if (['list_files', 'read_file', 'search_files', 'get_workspace_info'].includes(name)) {
      const result = executeTool(root, 'demo', name, payload)
      assert.equal(result.state, 'rejected', name)
      assertActionableRejection(result.output, name)
      continue
    }
    if (name === 'list_file_operations') {
      const result = listFileOperations({
        database: db,
        workspacePath: root,
        missionId: mission.id,
        argumentsText: payload
      })
      assert.equal(result.state, 'rejected', name)
      assertActionableRejection(result.output, name)
      continue
    }
    if (name === 'run_command') {
      const result = await runBrokerCommand({
        root,
        database: db,
        missionId: mission.id,
        callId: `unknown-${name}`,
        argumentsText: payload,
        signal: new AbortController().signal
      })
      assert.equal(result.state, 'rejected', name)
      assertActionableRejection(result.output, name)
      continue
    }
    if (name === 'submit_result') {
      const result = parseCompletion(payload)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assertActionableRejection(result.error, name)
      }
      continue
    }
    const result = proposeMutation({
      root,
      database: db,
      missionId: mission.id,
      callId: `unknown-${name}`,
      workspacePath: root,
      name: name as 'create_file' | 'edit_file' | 'delete_file' | 'rename_file' | 'restore_file',
      argumentsText: payload
    })
    assert.equal(result.execution.state, 'rejected', name)
    assertActionableRejection(result.execution.output, name)
  }
  db.close()
})

test('run_command accepts workingDirectory alias and explains schema rejections', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-cwd-alias-'))
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const mission = db.createAgentMission(root, 'cwd alias')
  const ok = await runBrokerCommand({
    root,
    database: db,
    missionId: mission.id,
    callId: 'alias',
    argumentsText: JSON.stringify({
      command: 'node',
      args: ['-e', 'console.log(1)'],
      workingDirectory: '.',
      explanation: 'alias cwd',
      timeout_ms: 10_000
    }),
    signal: new AbortController().signal
  })
  // node -e is blocked by policy; alias must parse first. Use npm --version instead.
  void ok
  const parsed = await runBrokerCommand({
    root,
    database: db,
    missionId: mission.id,
    callId: 'alias-ok',
    argumentsText: JSON.stringify({
      command: 'npm',
      args: ['--version'],
      workingDirectory: '.',
      explanation: 'alias cwd',
      timeout_ms: 30_000
    }),
    signal: new AbortController().signal
  })
  assert.equal(parsed.state, 'success', parsed.output)

  const rejected = await runBrokerCommand({
    root,
    database: db,
    missionId: mission.id,
    callId: 'bad-key',
    argumentsText: JSON.stringify({
      command: 'npm',
      args: ['--version'],
      cwd: '.',
      explanation: 'bad key',
      timeout_ms: 30_000
    }),
    signal: new AbortController().signal
  })
  assert.equal(rejected.state, 'rejected')
  assert.match(rejected.output, /cwd: unrecognized key/)
  assert.match(rejected.output, /Put the program in `command`|Example:/)
  db.close()
})

test('explanation is optional and executable is a documented command alias', async () => {
  assert.equal(
    (TOOL_PARAMETER_SCHEMAS.create_file.required as readonly string[]).includes('explanation'),
    false
  )
  assert.equal((TOOL_PARAMETER_SCHEMAS.run_command.required as readonly string[]).includes('explanation'), false)
  assert.ok('executable' in TOOL_PARAMETER_SCHEMAS.run_command.properties)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-optional-'))
  const db = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const mission = db.createAgentMission(root, 'optional explanation')

  const created = proposeMutation({
    root,
    database: db,
    missionId: mission.id,
    callId: 'no-explain',
    workspacePath: root,
    name: 'create_file',
    argumentsText: JSON.stringify({ path: 'note.txt', content: 'hi' })
  })
  assert.equal(created.execution.state, 'success', created.execution.output)

  const viaExecutable = await runBrokerCommand({
    root,
    database: db,
    missionId: mission.id,
    callId: 'exec-alias',
    argumentsText: JSON.stringify({
      executable: 'npm',
      args: ['--version'],
      working_directory: '.',
      timeout_ms: 30_000
    }),
    signal: new AbortController().signal
  })
  assert.equal(viaExecutable.state, 'success', viaExecutable.output)

  const spaced = await runBrokerCommand({
    root,
    database: db,
    missionId: mission.id,
    callId: 'spaced',
    argumentsText: JSON.stringify({
      command: 'pnpm exec tsc --noEmit',
      args: [],
      timeout_ms: 30_000
    }),
    signal: new AbortController().signal
  })
  assert.equal(spaced.state, 'rejected')
  assert.match(spaced.output, /Put the program in `command` and each argument in `args`/)

  const stillRejectsUnknown = await runBrokerCommand({
    root,
    database: db,
    missionId: mission.id,
    callId: 'unknown',
    argumentsText: JSON.stringify({
      command: 'npm',
      args: ['--version'],
      shell: true,
      timeout_ms: 30_000
    }),
    signal: new AbortController().signal
  })
  assert.equal(stillRejectsUnknown.state, 'rejected')
  assert.match(stillRejectsUnknown.output, /shell: unrecognized key/)
  db.close()
})
