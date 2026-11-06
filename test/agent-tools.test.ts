import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AGENT_LIMITS } from '../src/shared/agent.ts'
import { executeTool } from '../src/main/agent/tools.ts'

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kern-tools-'))
}

test('reads and lists files inside the workspace', () => {
  const root = temporaryDirectory()
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'note.txt'), 'visible note')
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.writeFileSync(path.join(root, 'node_modules', 'skip.txt'), 'hidden')
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret')

  const listed = executeTool(root, 'demo', 'list_files', JSON.stringify({ path: '.' }))
  assert.equal(listed.state, 'finished')
  assert.match(listed.output, /"path":"src"/)
  assert.equal(listed.output.includes('node_modules'), false)
  assert.equal(listed.output.includes('.env'), false)
  const nested = executeTool(root, 'demo', 'list_files', JSON.stringify({ path: 'src' }))
  assert.match(nested.output, /note\.txt/)

  const read = executeTool(root, 'demo', 'read_file', JSON.stringify({ path: 'src/note.txt' }))
  assert.equal(read.state, 'finished')
  assert.match(read.output, /visible note/)

  const info = executeTool(root, 'demo', 'get_workspace_info', '{}')
  assert.equal(info.state, 'finished')
  assert.equal(info.output.includes(root), false)
  const parsed = JSON.parse(info.output) as { name: string; open: boolean }
  assert.equal(parsed.name, 'demo')
  assert.equal(parsed.open, true)

  const found = executeTool(root, 'demo', 'search_files', JSON.stringify({ query: 'visible' }))
  assert.equal(found.state, 'finished')
  assert.match(found.output, /src\/note\.txt/)
})

test('rejects invalid paths, traversal, and symlink escapes', () => {
  const root = temporaryDirectory()
  const outside = temporaryDirectory()
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'hidden')
  fs.writeFileSync(path.join(root, 'inside.txt'), 'visible')
  fs.symlinkSync(outside, path.join(root, 'escape-link'))
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'secret-link.txt'))

  for (const target of ['../secret.txt', '/etc/passwd', 'escape-link/secret.txt', 'secret-link.txt']) {
    const result = executeTool(root, 'demo', 'read_file', JSON.stringify({ path: target }))
    assert.equal(result.state, 'rejected', target)
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'hidden')
  }

  const missing = executeTool(root, 'demo', 'read_file', JSON.stringify({ path: 'missing.txt' }))
  assert.equal(missing.state, 'rejected')
  const env = executeTool(root, 'demo', 'read_file', JSON.stringify({ path: '.env' }))
  assert.equal(env.state, 'rejected')
})

test('bounds tool output and rejects unsupported tools', () => {
  const root = temporaryDirectory()
  fs.writeFileSync(path.join(root, 'big.txt'), 'a'.repeat(AGENT_LIMITS.maxToolOutputChars + 500))
  const read = executeTool(root, 'demo', 'read_file', JSON.stringify({ path: 'big.txt' }))
  assert.equal(read.state, 'finished')
  assert.ok(read.output.length <= AGENT_LIMITS.maxToolOutputChars + 20)
  assert.match(read.output, /truncated/)

  const before = fs.readdirSync(root)
  for (const name of ['write_file', 'delete_file', 'run_terminal', 'git_commit', 'submit_result']) {
    const result = executeTool(root, 'demo', name, JSON.stringify({ path: 'created.txt', command: 'rm -rf /' }))
    assert.equal(result.state, 'rejected', name)
    assert.match(result.output, /not available/)
  }
  assert.deepEqual(fs.readdirSync(root), before)
  assert.equal(fs.existsSync(path.join(root, 'created.txt')), false)
})
