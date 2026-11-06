import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectFiles,
  fileMatches,
  hasExternalChange,
  isDirty,
  isSessionRecord,
  secretLabel,
  type TreeEntry
} from '../src/renderer/src/editorState.ts'

test('secret status uses the exact renderer labels', () => {
  assert.equal(secretLabel(true, false), 'No key')
  assert.equal(secretLabel(true, true), 'Key stored')
  assert.equal(secretLabel(false, true), 'Secure storage unavailable')
})

test('dirty state and external changes compare full text', () => {
  assert.equal(isDirty('a\n', 'a\n'), false)
  assert.equal(isDirty('a\n', 'b\n'), true)
  assert.equal(hasExternalChange('opened\n', 'opened\n'), false)
  assert.equal(hasExternalChange('opened\n', 'disk\n'), true)
})

test('file search matches names and skips node_modules and .git', async () => {
  assert.equal(fileMatches('src/App.tsx', 'app'), true)
  assert.equal(fileMatches('src/App.tsx', 'missing'), false)
  const tree = new Map<string, TreeEntry[]>([
    [
      '.',
      [
        { name: 'src', relativePath: 'src', kind: 'directory', blocked: false },
        { name: 'node_modules', relativePath: 'node_modules', kind: 'directory', blocked: false },
        { name: '.git', relativePath: '.git', kind: 'directory', blocked: false },
        { name: 'README.md', relativePath: 'README.md', kind: 'file', blocked: false }
      ]
    ],
    [
      'src',
      [
        { name: 'App.tsx', relativePath: 'src/App.tsx', kind: 'file', blocked: false },
        { name: 'escape', relativePath: 'src/escape', kind: 'file', blocked: true }
      ]
    ],
    ['node_modules', [{ name: 'App.tsx', relativePath: 'node_modules/App.tsx', kind: 'file', blocked: false }]],
    ['.git', [{ name: 'config', relativePath: '.git/config', kind: 'file', blocked: false }]]
  ])
  const found = await collectFiles(async (directory) => tree.get(directory) ?? [], 'app')
  assert.deepEqual(
    found.map((entry) => entry.relativePath),
    ['src/App.tsx']
  )
})

test('session records reject incomplete history rows', () => {
  assert.equal(
    isSessionRecord({ id: '1', title: 'kern', status: 'open', createdAt: '2026-11-06T00:00:00.000Z' }),
    true
  )
  assert.equal(isSessionRecord({ id: '1', title: 'kern' }), false)
  assert.equal(isSessionRecord(null), false)
})
