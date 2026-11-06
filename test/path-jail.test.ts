import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PathJailError, resolveEntry, resolveInside } from '../src/main/security/pathJail.ts'
import { writeFileAtomic } from '../src/main/services/atomicWrite.ts'
import { MissionDatabase } from '../src/main/services/database.ts'
import { WorkspaceService } from '../src/main/services/workspace.ts'

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kern-jail-'))
}

test('rejects traversal, absolute paths, and symlink escapes', () => {
  const root = temporaryDirectory()
  const outside = temporaryDirectory()
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'hidden')
  fs.symlinkSync(outside, path.join(root, 'escape-link'))
  fs.mkdirSync(path.join(root, 'nested'))
  fs.writeFileSync(path.join(root, 'nested', 'inside.txt'), 'visible')
  fs.symlinkSync(path.join(root, 'nested', 'inside.txt'), path.join(root, 'safe-link.txt'))

  assert.throws(() => resolveInside(root, '../outside.txt'), PathJailError)
  assert.throws(() => resolveInside(root, '/etc/passwd'), PathJailError)
  assert.throws(() => resolveInside(root, 'escape-link'), PathJailError)
  assert.throws(() => resolveInside(root, 'escape-link/secret.txt'), PathJailError)
  assert.equal(fs.readFileSync(resolveInside(root, 'safe-link.txt'), 'utf8'), 'visible')
  assert.equal(fs.readFileSync(resolveInside(root, 'nested/inside.txt'), 'utf8'), 'visible')
})

test('delete removes a symlink without deleting its outside target', () => {
  const root = temporaryDirectory()
  const outside = temporaryDirectory()
  const target = path.join(outside, 'secret.txt')
  fs.writeFileSync(target, 'keep')
  fs.symlinkSync(target, path.join(root, 'escape-link'))
  const database = new MissionDatabase(path.join(temporaryDirectory(), 'kern.sqlite'))
  const workspace = new WorkspaceService(database)
  workspace.open(root)
  assert.throws(() => workspace.remove('escape-link', false), /Confirmation is required/)
  workspace.remove('escape-link', true)
  assert.equal(fs.existsSync(target), true)
  assert.equal(fs.existsSync(path.join(root, 'escape-link')), false)
  assert.throws(() => workspace.remove('.', true), /workspace root/)
  database.close()
})

test('atomic write replaces a file without leaving a temporary sibling', () => {
  const root = temporaryDirectory()
  const target = path.join(root, 'notes.txt')
  writeFileAtomic(target, 'one')
  writeFileAtomic(target, 'two')
  assert.equal(fs.readFileSync(target, 'utf8'), 'two')
  const leftovers = fs.readdirSync(root).filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('workspace writes stay inside the root and are recorded', () => {
  const root = temporaryDirectory()
  const database = new MissionDatabase(path.join(temporaryDirectory(), 'kern.sqlite'))
  const workspace = new WorkspaceService(database)
  const opened = workspace.open(root)
  assert.equal(opened.path, fs.realpathSync(root))
  workspace.createFile('kern-phase1.txt', 'version-1\n')
  workspace.write('kern-phase1.txt', 'version-2\n')
  assert.equal(workspace.read('kern-phase1.txt'), 'version-2\n')
  assert.throws(() => workspace.write('../escaped.txt', 'no'), PathJailError)
  const changes = workspace.listFileChanges()
  assert.equal(changes.some((change) => change.relativePath === 'kern-phase1.txt'), true)
  assert.equal(workspace.listMissions().length, 1)
  const restored = new WorkspaceService(database)
  assert.equal(restored.restore()?.path, fs.realpathSync(root))
  database.close()
})

test('rename requires confirmation and cannot leave the workspace', () => {
  const root = temporaryDirectory()
  const database = new MissionDatabase(path.join(temporaryDirectory(), 'kern.sqlite'))
  const workspace = new WorkspaceService(database)
  workspace.open(root)
  workspace.createFile('old.txt', 'value')
  assert.throws(() => workspace.rename('old.txt', 'new.txt', false), /Confirmation is required/)
  workspace.rename('old.txt', 'new.txt', true)
  assert.equal(workspace.read('new.txt'), 'value')
  assert.throws(() => workspace.rename('new.txt', '../other.txt', true), PathJailError)
  const entry = resolveEntry(root, 'new.txt')
  assert.equal(entry.exists, true)
  database.close()
})
