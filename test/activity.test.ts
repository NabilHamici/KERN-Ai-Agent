import assert from 'node:assert/strict'
import test from 'node:test'
import { agentActivity, completedActivitySteps, REFACTOR_TOOLS } from '../src/renderer/src/activity.ts'

test('analyzing is Thinking and progress stays unestimated', () => {
  const activity = agentActivity({ running: true, status: 'analyzing' })
  assert.equal(activity.phase, 'thinking')
  assert.equal(activity.label, 'Thinking')
  assert.equal(activity.detail.includes('Understanding'), true)
  assert.equal(activity.progress, null)
})

test('directory tools inspect, search tools search, and reads inspect source', () => {
  assert.equal(agentActivity({ running: true, status: 'executing', toolName: 'search_files', toolState: 'awaiting_approval' }).phase, 'searching')
  assert.equal(agentActivity({ running: true, status: 'executing', toolName: 'list_files', toolState: 'awaiting_approval' }).phase, 'inspecting')
  assert.equal(agentActivity({ running: true, status: 'executing', toolName: 'read_file', toolState: 'awaiting_approval' }).phase, 'reading')
  assert.equal(agentActivity({ running: true, status: 'executing', toolName: 'get_workspace_info', toolState: 'awaiting_approval' }).phase, 'inspecting')
})

test('planning verifying and waiting for approval use real mission status', () => {
  assert.equal(agentActivity({ running: true, status: 'planning' }).label, 'Planning')
  assert.equal(agentActivity({ running: true, status: 'verifying' }).label, 'Verifying')
  assert.equal(agentActivity({ running: true, status: 'awaiting_approval' }).label, 'Waiting for approval')
})

test('editing appears for real mutation tools only', () => {
  assert.equal(REFACTOR_TOOLS.has('edit_file'), true)
  assert.equal(
    agentActivity({ running: true, status: 'executing', toolName: 'edit_file', toolState: 'awaiting_approval' }).phase,
    'editing'
  )
  assert.equal(agentActivity({ running: true, status: 'executing', toolName: 'read_file', toolState: 'awaiting_approval' }).phase, 'reading')
  assert.equal(agentActivity({ running: true, status: 'awaiting_approval' }).label.includes('%'), false)
})

test('a finished tool does not keep the search label while the model is working', () => {
  const activity = agentActivity({ running: true, status: 'analyzing', toolName: 'search_files', toolState: 'success' })
  assert.equal(activity.phase, 'thinking')
})

test('completed activity steps summarize tools without inventing phases', () => {
  const steps = completedActivitySteps([
    {
      callId: '1',
      name: 'list_files',
      argumentsText: '{"path":"."}',
      state: 'success',
      output: 'ok'
    },
    {
      callId: '2',
      name: 'search_files',
      argumentsText: '{"query":"auth"}',
      state: 'success',
      output: 'ok'
    },
    {
      callId: '3',
      name: 'submit_result',
      argumentsText: '{}',
      state: 'success',
      output: 'ok'
    }
  ])
  assert.deepEqual(steps, ['Project structure inspected', 'Search completed'])
})
