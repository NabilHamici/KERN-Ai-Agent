import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  fixtureAwaitingApproval,
  fixtureCancelled,
  fixtureExpoPartial,
  fixtureFailedInstall,
  fixtureVerifiedSuccess
} from '../src/renderer/src/agent/fixtures.ts'
import { buildTimeline } from '../src/renderer/src/agent/timeline.ts'
import { connectionLabel, modelDisplayName } from '../src/shared/provider.ts'

const panelSources = [
  'src/renderer/src/components/AgentPanel.tsx',
  'src/renderer/src/agent/components/StatusBar.tsx',
  'src/renderer/src/agent/components/HistoryMenu.tsx',
  'src/renderer/src/agent/components/Composer.tsx',
  'src/renderer/src/agent/components/Timeline.tsx',
  'src/renderer/src/agent/components/ContextChip.tsx',
  'src/renderer/src/agent/components/ChangesBar.tsx',
  'src/renderer/src/agent/components/FinalResultCard.tsx',
  'src/renderer/src/agent/components/stepCards.tsx',
  'src/renderer/src/App.tsx',
  'src/renderer/src/components/TopBar.tsx'
]
  .map((relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'))
  .join('\n')

test('UI no longer advertises Cursor Verified or Composer 2.5 placeholders', () => {
  assert.equal(panelSources.includes('Composer 2.5'), false)
  assert.equal(panelSources.includes('Cursor Verified'), false)
  assert.equal(/Idle \/ Ready/.test(panelSources), false)
  assert.equal(panelSources.includes('data-live-activity'), false)
  assert.equal(panelSources.includes('data-agent-status-bar'), true)
  assert.equal(panelSources.includes('data-context-chip'), true)
  assert.equal(modelDisplayName('bharatcode'), 'qwen-3.8-27b')
  assert.equal(modelDisplayName('cursor'), 'composer-2.5')
  assert.equal(connectionLabel('verified', false), 'Healthy')
  assert.equal(connectionLabel('credentials_stored', false), 'Key stored')
})

test('only one status bar marker exists in agent panel sources', () => {
  const matches = panelSources.match(/data-agent-status-bar/g) ?? []
  assert.equal(matches.length, 1)
  assert.equal((panelSources.match(/data-live-activity/g) ?? []).length, 0)
  assert.equal((panelSources.match(/agent-live\b/g) ?? []).length, 0)
})

test('final result fixtures map to distinct statuses', () => {
  const statuses = [
    buildTimeline(fixtureExpoPartial).find((item) => item.kind === 'final_result'),
    buildTimeline(fixtureVerifiedSuccess).find((item) => item.kind === 'final_result'),
    buildTimeline(fixtureFailedInstall).find((item) => item.kind === 'final_result'),
    buildTimeline(fixtureCancelled).find((item) => item.kind === 'final_result')
  ]
  assert.equal(statuses[0]?.kind === 'final_result' && statuses[0].result.status, 'partially_completed')
  assert.equal(statuses[1]?.kind === 'final_result' && statuses[1].result.status, 'completed_verified')
  assert.equal(statuses[2]?.kind === 'final_result' && statuses[2].result.status, 'failed')
  assert.equal(statuses[3]?.kind === 'final_result' && statuses[3].result.status, 'cancelled')
  assert.ok(buildTimeline(fixtureAwaitingApproval).some((item) => item.kind === 'approval'))
})

test('history is dropdown-backed and context is a chip', () => {
  const ui = [
    fs.readFileSync(new URL('../src/renderer/src/components/AgentPanel.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/renderer/src/agent/components/HistoryMenu.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/renderer/src/agent/components/ContextChip.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/renderer/src/agent/components/Composer.tsx', import.meta.url), 'utf8')
  ].join('\n')
  assert.match(ui, /history-menu-toggle/)
  assert.match(ui, /Context ·/)
  assert.doesNotMatch(ui, /chat-history-label/)
  assert.doesNotMatch(ui, /Recent chats/)
})
