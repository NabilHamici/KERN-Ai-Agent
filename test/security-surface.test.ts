import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function sourceFiles(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(full)
    }
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
  })
}

test('renderer and preload do not import privileged modules', () => {
  const forbidden = [
    'node:fs',
    'node:child_process',
    'node-pty',
    'electron-safeStorage',
    "from 'fs'",
    'from "fs"',
    'safeStorage',
    'shell.openPath'
  ]
  const files = [
    ...sourceFiles(path.join('src', 'renderer')),
    ...sourceFiles(path.join('src', 'preload'))
  ]
  assert.ok(files.length > 0)
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file} contains ${token}`)
    }
  }
})
