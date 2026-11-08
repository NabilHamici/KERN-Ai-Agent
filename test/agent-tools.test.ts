import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AGENT_LIMITS } from '../src/shared/agent.ts'
import { executeTool, type ReadCache } from '../src/main/agent/tools.ts'

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
  assert.equal(listed.state, 'success')
  assert.match(listed.output, /"path":"src"/)
  assert.match(listed.output, /"path":"node_modules"/)
  assert.match(listed.output, /"regenerable":true/)
  assert.equal(listed.output.includes('node_modules/skip'), false)
  assert.equal(listed.output.includes('.env'), false)
  const nested = executeTool(root, 'demo', 'list_files', JSON.stringify({ path: 'src' }))
  assert.match(nested.output, /note\.txt/)

  const read = executeTool(root, 'demo', 'read_file', JSON.stringify({ path: 'src/note.txt' }))
  assert.equal(read.state, 'success')
  assert.match(read.output, /visible note/)

  const info = executeTool(root, 'demo', 'get_workspace_info', '{}')
  assert.equal(info.state, 'success')
  assert.equal(info.output.includes(root), false)
  const parsed = JSON.parse(info.output) as { name: string; open: boolean }
  assert.equal(parsed.name, 'demo')
  assert.equal(parsed.open, true)

  const found = executeTool(root, 'demo', 'search_files', JSON.stringify({ query: 'visible' }))
  assert.equal(found.state, 'success')
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
  assert.equal(read.state, 'success')
  assert.ok(read.output.length <= AGENT_LIMITS.maxToolOutputChars + 40)
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

test('rejects an extra search field and an empty directory without dropping the reason', () => {
  const root = temporaryDirectory()
  fs.writeFileSync(path.join(root, 'README.md'), 'alpha')
  const search = executeTool(root, 'demo', 'search_files', JSON.stringify({ query: 'readme', max_results: 20 }))
  assert.equal(search.state, 'rejected')
  assert.match(search.output, /unrecognized key max_results/)
  assert.equal(search.output.includes('alpha'), false)

  const listed = executeTool(root, 'demo', 'list_files', JSON.stringify({ path: '' }))
  assert.equal(listed.state, 'success')
  assert.match(listed.output, /"path":"."/)

  const validSearch = executeTool(root, 'demo', 'search_files', JSON.stringify({ query: 'readme' }))
  assert.equal(validSearch.state, 'success')
  assert.match(validSearch.output, /README\.md/)
  const validList = executeTool(root, 'demo', 'list_files', JSON.stringify({ path: '.' }))
  assert.equal(validList.state, 'success')
  assert.match(validList.output, /README\.md/)
})

test('a second read of the same file in one turn does not read it again', () => {
  const root = temporaryDirectory()
  fs.writeFileSync(path.join(root, 'README.md'), 'alpha')
  const cache: ReadCache = { files: new Map() }
  const first = executeTool(root, 'demo', 'read_file', JSON.stringify({ path: './README.md' }), cache)
  assert.match(first.output, /alpha/)
  fs.writeFileSync(path.join(root, 'README.md'), 'beta')
  const second = executeTool(root, 'demo', 'read_file', JSON.stringify({ path: 'README.md' }), cache)
  const parsed = JSON.parse(second.output) as { duplicate?: boolean; sameAs?: string; content?: string }
  assert.equal(parsed.duplicate, true)
  assert.equal(parsed.sameAs, 'README.md')
  assert.equal(parsed.content, undefined)
  assert.equal(second.output.includes('beta'), false)

  let sameInode = false
  try {
    sameInode = fs.statSync(path.join(root, 'readme.md')).ino === fs.statSync(path.join(root, 'README.md')).ino
  } catch {
    sameInode = false
  }
  if (sameInode) {
    const folded = executeTool(root, 'demo', 'read_file', JSON.stringify({ path: 'readme.md' }), cache)
    const foldedParsed = JSON.parse(folded.output) as { duplicate?: boolean; sameAs?: string }
    assert.equal(foldedParsed.duplicate, true)
    assert.equal(foldedParsed.sameAs, 'README.md')
    assert.equal(folded.output.includes('beta'), false)
  }

  const other = executeTool(root, 'demo', 'read_file', JSON.stringify({ path: 'README.md' }))
  assert.match(other.output, /beta/)
})
