import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fixtureAwaitingApproval,
  fixtureCancelled,
  fixtureExpoPartial,
  fixtureFailedInstall,
  fixtureHugeOutput,
  fixtureLargeMission,
  fixtureVerifiedSuccess
} from '../src/renderer/src/agent/fixtures.ts'
import { deriveAgentUiStatus, formatElapsed, statusPhaseKey } from '../src/renderer/src/agent/statusMachine.ts'
import { buildFinalResult, buildTimeline } from '../src/renderer/src/agent/timeline.ts'

test('buildTimeline groups reads into Explored N files', () => {
  const large = fixtureLargeMission(14)
  const items = buildTimeline(large)
  const group = items.find((item) => item.kind === 'step_group')
  assert.ok(group && group.kind === 'step_group')
  assert.equal(group.label, 'Explored 14 files')
  assert.equal(group.count, 14)
  assert.equal(group.collapsed, true)
})

test('buildTimeline collapses rejected then retried tool into one step', () => {
  const items = buildTimeline(fixtureExpoPartial)
  const edits = items.filter((item) => item.kind === 'edit')
  assert.equal(edits.length, 1)
  assert.ok(edits[0] && edits[0].kind === 'edit')
  assert.equal(edits[0].step.retries, 1)
  assert.ok((edits[0].step.attempts?.length ?? 0) >= 2)
  assert.equal(edits[0].step.state, 'success')
})

test('buildTimeline merges duplicate narration lines', () => {
  const items = buildTimeline({
    messages: [
      {
        key: 'a1',
        role: 'assistant',
        content: 'Checking the workspace.\nChecking the workspace.\nLooking at package.json.',
        streaming: false,
        activities: []
      }
    ],
    tools: [],
    operations: [],
    mission: null
  })
  const text = items.find((item) => item.kind === 'assistant_text')
  assert.ok(text && text.kind === 'assistant_text')
  assert.equal(text.text.includes('Checking the workspace.\nChecking the workspace.'), false)
  assert.match(text.text, /Checking the workspace/)
})

test('FinalResult never claims Verified without exit-0 verification command', () => {
  const partial = buildFinalResult(
    fixtureExpoPartial.mission,
    fixtureExpoPartial.tools,
    fixtureExpoPartial.operations
  )
  assert.equal(partial.verified, false)
  assert.equal(partial.title.includes('Verified'), false)
  assert.match(partial.verification, /tsc|exit 2/i)

  const success = buildFinalResult(
    fixtureVerifiedSuccess.mission,
    fixtureVerifiedSuccess.tools,
    fixtureVerifiedSuccess.operations
  )
  assert.equal(success.verified, true)
  assert.equal(success.status, 'completed_verified')
  assert.match(success.title, /Verified/)

  const noVerify = buildFinalResult(
    { ...fixtureVerifiedSuccess.mission, summary: 'Created a file.' },
    fixtureVerifiedSuccess.tools.filter((tool) => tool.name !== 'run_command'),
    []
  )
  assert.equal(noVerify.verified, false)
  assert.equal(noVerify.verification, 'No verification was run')
})

test('FinalResult variants cover cancelled, failed, and approval fixtures', () => {
  assert.equal(buildFinalResult(fixtureCancelled.mission, [], []).status, 'cancelled')
  assert.equal(
    buildFinalResult(fixtureFailedInstall.mission, fixtureFailedInstall.tools, []).status,
    'failed'
  )
  const awaiting = buildTimeline(fixtureAwaitingApproval)
  assert.ok(awaiting.some((item) => item.kind === 'approval'))
})

test('status state machine covers idle, thinking, tool, approval, stopping, finished', () => {
  assert.equal(deriveAgentUiStatus({ running: false, missionStatus: null }).kind, 'idle')
  assert.equal(
    deriveAgentUiStatus({ running: true, missionStatus: 'analyzing', startedAt: 1 }).kind,
    'thinking'
  )
  const tool = deriveAgentUiStatus({
    running: true,
    missionStatus: 'executing',
    toolName: 'run_command',
    toolState: 'started',
    toolArgumentsText: '{"command":"pnpm","args":["install"]}',
    startedAt: 10
  })
  assert.equal(tool.kind, 'tool_running')
  if (tool.kind === 'tool_running') {
    assert.match(tool.target, /pnpm install/)
    assert.equal(tool.startedAt, 10)
  }
  assert.equal(
    deriveAgentUiStatus({
      running: true,
      missionStatus: 'awaiting_approval',
      pendingDeletionCount: 12
    }).kind,
    'awaiting_approval'
  )
  assert.equal(deriveAgentUiStatus({ running: true, missionStatus: 'executing', cancelling: true }).kind, 'stopping')
  assert.equal(
    deriveAgentUiStatus({ running: true, missionStatus: 'partially_completed' }).kind,
    'finished'
  )
  assert.equal(formatElapsed(0, 42_000), '00:42')
  assert.equal(statusPhaseKey({ kind: 'idle', label: 'Ready' }), 'idle')
})

test('500-step fixture builds quickly and groups exploration', () => {
  const started = Date.now()
  const items = buildTimeline(fixtureLargeMission(500))
  const elapsed = Date.now() - started
  assert.ok(elapsed < 500, `buildTimeline(500) took ${elapsed}ms`)
  const group = items.find((item) => item.kind === 'step_group')
  assert.ok(group && group.kind === 'step_group')
  assert.equal(group.count, 500)
})

test('10k-line output fixture stays a plain string for capped rendering', () => {
  assert.equal(fixtureHugeOutput.split('\n').length, 10_001)
})

test('failed install exposes diagnosis from warnings', () => {
  const items = buildTimeline(fixtureFailedInstall)
  const command = items.find((item) => item.kind === 'command' || item.kind === 'verification')
  assert.ok(command && (command.kind === 'command' || command.kind === 'verification'))
  assert.ok(command.step.diagnosis)
  assert.match(command.step.stderr ?? '', /ENOSPC|no space/i)
})
