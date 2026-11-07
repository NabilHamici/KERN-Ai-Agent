import assert from 'node:assert/strict'
import test from 'node:test'
import { agentActivity, REFACTOR_TOOLS } from '../src/renderer/src/activity.ts'

test('analyzing is Thinking and progress stays unestimated', () => {
  const activity = agentActivity({ running: true, status: 'analyzing' })
  assert.equal(activity.phase, 'thinking')
  assert.equal(activity.label, 'Thinking')
  assert.equal(activity.progress, null)
})

test('a directory or search tool is Scanning, and a read is Reading', () => {
  assert.equal(agentActivity({ running: true, status: 'executing', toolName: 'search_files', toolState: 'started' }).label, 'Scanning')
  assert.equal(agentActivity({ running: true, status: 'executing', toolName: 'list_files', toolState: 'started' }).label, 'Scanning')
  assert.equal(agentActivity({ running: true, status: 'executing', toolName: 'read_file', toolState: 'started' }).phase, 'reading')
  assert.equal(agentActivity({ running: true, status: 'executing', toolName: 'get_workspace_info', toolState: 'started' }).phase, 'executing')
})

test('planning and verifying appear only when the mission status is that phase', () => {
  assert.equal(agentActivity({ running: true, status: 'planning' }).label, 'Planning')
  assert.equal(agentActivity({ running: true, status: 'verifying' }).label, 'Verifying')
  assert.equal(agentActivity({ running: true, status: 'awaiting_approval' }).label, 'Awaiting approval')
})

test('refactoring stays unused until a write tool is registered', () => {
  assert.equal(REFACTOR_TOOLS.size, 0)
  const activity = agentActivity({ running: true, status: 'executing', toolName: 'read_file', toolState: 'started' })
  assert.equal(activity.phase === 'refactoring', false)
  assert.equal(activity.label.includes('%'), false)
})

test('a finished tool does not keep the scan label while the model is working', () => {
  const activity = agentActivity({ running: true, status: 'analyzing', toolName: 'search_files', toolState: 'finished' })
  assert.equal(activity.phase, 'thinking')
})
