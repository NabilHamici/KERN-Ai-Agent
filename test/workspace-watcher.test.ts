import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  coalesceWatchEvents,
  shouldIgnoreWatchPath,
  workspaceChangedEventSchema
} from '../src/shared/workspaceEvents.ts'
import { WorkspaceWatcher } from '../src/main/services/workspaceWatcher.ts'

test('ignore rules skip node_modules and most .git internals', () => {
  assert.equal(shouldIgnoreWatchPath('node_modules/foo'), true)
  assert.equal(shouldIgnoreWatchPath('src/node_modules/x'), true)
  assert.equal(shouldIgnoreWatchPath('.git/objects/ab'), true)
  assert.equal(shouldIgnoreWatchPath('.git/HEAD'), false)
  assert.equal(shouldIgnoreWatchPath('.git/index'), false)
  assert.equal(shouldIgnoreWatchPath('dist/out.js'), true)
  assert.equal(shouldIgnoreWatchPath('src/app.tsx'), false)
})

test('coalesceWatchEvents bounds bursts and falls back to top-level refresh', () => {
  const small = coalesceWatchEvents([
    { path: 'a/b.txt', kind: 'add' },
    { path: 'a/c.txt', kind: 'change' },
    { path: 'd/e.txt', kind: 'unlink' }
  ])
  assert.ok(small.changes.length <= 200)
  assert.equal(small.truncated, false)

  const burst = Array.from({ length: 2_500 }, (_, index) => ({
    path: `pkg/file-${index}.js`,
    kind: 'add' as const
  }))
  const coalesced = coalesceWatchEvents(burst)
  assert.equal(coalesced.truncated, true)
  assert.ok(coalesced.changes.length <= 40)
  assert.ok(coalesced.changes.every((entry) => entry.kind === 'refresh'))
})

test('workspace.changed schema validates batched payloads', () => {
  const parsed = workspaceChangedEventSchema.safeParse({
    type: 'workspace.changed',
    root: '/tmp/project',
    changes: [{ path: 'src', kind: 'refresh', isDirectory: true }],
    truncated: false,
    reason: 'command'
  })
  assert.equal(parsed.success, true)
})

test('WorkspaceWatcher emits bounded events for nested creates and deletes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-watch-'))
  const events: Array<{ truncated: boolean; count: number; reason?: string }> = []
  const watcher = new WorkspaceWatcher((event) => {
    events.push({ truncated: event.truncated, count: event.changes.length, reason: event.reason })
  }, 80)
  try {
    watcher.start(root)
    fs.mkdirSync(path.join(root, 'nested', 'deep'), { recursive: true })
    for (let index = 0; index < 40; index += 1) {
      fs.writeFileSync(path.join(root, 'nested', 'deep', `f-${index}.txt`), 'x')
    }
    await waitFor(() => events.length > 0, 2_000)
    assert.ok(events.some((item) => item.count > 0 && item.count <= 500))

    events.length = 0
    const flood = path.join(root, 'flood')
    fs.mkdirSync(flood)
    for (let index = 0; index < 5_200; index += 1) {
      fs.writeFileSync(path.join(flood, `n-${index}.txt`), 'y')
    }
    watcher.notifyRefresh(['flood', '.'], 'command')
    await waitFor(() => events.some((item) => item.reason === 'command'), 2_000)
    const commandEvent = events.find((item) => item.reason === 'command')
    assert.ok(commandEvent)
    assert.ok(commandEvent!.count <= 500)

    events.length = 0
    watcher.suppress(5_000)
    fs.writeFileSync(path.join(root, 'suppressed.txt'), 'z')
    await sleep(200)
    assert.equal(events.length, 0)

    fs.rmSync(path.join(root, 'nested'), { recursive: true, force: true })
    watcher.notifyRefresh(['nested'], 'manual')
    await waitFor(() => events.some((item) => item.reason === 'manual'), 2_000)
  } finally {
    watcher.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await sleep(40)
  }
  throw new Error('Timed out waiting for watcher events')
}
