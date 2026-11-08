import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MissionDatabase } from '../src/main/services/database.ts'
import {
  appendStreamDelta,
  appendToolActivity,
  canCancel,
  canSend,
  composeOnEnter,
  conversationFromTranscript,
  markActivityAwaitingApproval,
  messageBlocks,
  sealConversation,
  shouldFollowTranscript,
  showResponseIndicator
} from '../src/renderer/src/conversation.ts'
import type { AgentTranscript } from '../src/shared/agent.ts'

const panel = [
  fs.readFileSync(new URL('../src/renderer/src/components/AgentPanel.tsx', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../src/renderer/src/agent/components/StatusBar.tsx', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../src/renderer/src/agent/components/HistoryMenu.tsx', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../src/renderer/src/agent/components/Composer.tsx', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../src/renderer/src/agent/components/Timeline.tsx', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../src/renderer/src/agent/components/ChangesBar.tsx', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('../src/renderer/src/agent/components/ContextChip.tsx', import.meta.url), 'utf8')
].join('\n')
const app = fs.readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')

function transcript(patch: {
  mission?: Partial<AgentTranscript['mission']>
  messages?: AgentTranscript['messages']
  tools?: AgentTranscript['tools']
} = {}): AgentTranscript {
  return {
    mission: {
      id: 'mission-1',
      chatId: null,
      title: 'Read note.txt',
      prompt: 'Read note.txt',
      status: 'completed',
      iteration: 1,
      toolCalls: 1,
      summary: 'Read note.txt',
      error: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:03.000Z',
      ...patch.mission
    },
    messages: patch.messages ?? [
      { role: 'assistant', content: 'The file exists.', createdAt: '2026-01-01T00:00:01.000Z' }
    ],
    tools: patch.tools ?? [
      {
        callId: 'call-1',
        name: 'read_file',
        argumentsText: '{"path":"note.txt"}',
        state: 'finished',
        output: 'visible',
        createdAt: '2026-01-01T00:00:02.000Z'
      }
    ],
    operations: []
  }
}

test('a restored mission shows one assistant response with nested tool activity', () => {
  const entries = conversationFromTranscript(transcript())
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.role, 'user')
  assert.equal(entries[1]?.role, 'assistant')
  assert.equal(entries[1]?.content.includes('The file exists.'), true)
  assert.equal(entries[1]?.activities.length, 1)
  assert.equal(entries[1]?.activities[0]?.name, 'read_file')
  assert.equal(entries[1]?.activities[0]?.detail, 'note.txt')
  assert.equal(entries[1]?.activities[0]?.state, 'completed')
  assert.equal(entries.every((entry) => entry.role === 'user' || entry.role === 'assistant'), true)
  assert.equal(entries.every((entry) => entry.streaming), false)
})

test('five tool calls stay inside one assistant response', () => {
  const tools = Array.from({ length: 5 }, (_, index) => ({
    callId: `call-${index}`,
    name: index % 2 === 0 ? 'read_file' : 'search_files',
    argumentsText: index % 2 === 0 ? `{"path":"f${index}.ts"}` : `{"query":"q${index}"}`,
    state: 'finished' as const,
    output: 'ok',
    createdAt: `2026-01-01T00:00:0${index}.000Z`
  }))
  const entries = conversationFromTranscript(
    transcript({
      messages: [{ role: 'assistant', content: 'Working through the request.', createdAt: '2026-01-01T00:00:00.000Z' }],
      tools,
      mission: { summary: 'Done.', status: 'completed' }
    })
  )
  const assistant = entries.filter((entry) => entry.role === 'assistant')
  assert.equal(assistant.length, 1)
  assert.equal(assistant[0]?.activities.length, 5)
  assert.equal(entries.filter((entry) => entry.role === 'user').length, 1)
})

test('assistant streaming text and tools update the same response container', () => {
  let entries = conversationFromTranscript(transcript({ messages: [], tools: [], mission: { summary: null, status: 'analyzing' } }))
  assert.equal(entries[0]?.content, 'Read note.txt')
  assert.equal(showResponseIndicator(true, entries), true)
  entries = appendStreamDelta(entries, 'The ')
  entries = appendStreamDelta(entries, 'file exists.')
  assert.equal(entries.filter((entry) => entry.role === 'assistant').length, 1)
  assert.equal(entries[1]?.content, 'The file exists.')
  assert.equal(entries[1]?.streaming, true)
  assert.equal(showResponseIndicator(true, entries), false)
  entries = appendToolActivity(entries, {
    callId: 'call-1',
    name: 'read_file',
    argumentsText: '{"path":"note.txt"}',
    state: 'started'
  })
  entries = appendToolActivity(entries, {
    callId: 'call-1',
    name: 'read_file',
    argumentsText: '{"path":"note.txt"}',
    state: 'finished'
  })
  entries = appendStreamDelta(entries, ' Verified.')
  assert.equal(entries.filter((entry) => entry.role === 'assistant').length, 1)
  assert.equal(entries[1]?.content, 'The file exists. Verified.')
  assert.equal(entries[1]?.activities.length, 1)
  assert.equal(entries[1]?.activities[0]?.state, 'completed')
  entries = sealConversation(entries)
  assert.equal(entries[1]?.streaming, false)
  assert.equal(showResponseIndicator(false, entries), false)
})

test('awaiting approval marks running tool rows without adding messages', () => {
  let entries = conversationFromTranscript(transcript({ messages: [], tools: [], mission: { summary: null } }))
  entries = appendToolActivity(entries, {
    callId: 'edit-1',
    name: 'edit_file',
    argumentsText: '{"path":"a.ts","content":"x","explanation":"fix"}',
    state: 'started'
  })
  entries = markActivityAwaitingApproval(entries)
  assert.equal(entries.length, 2)
  assert.equal(entries[1]?.activities[0]?.state, 'awaiting_approval')
})

test('the final transcript replaces the stream with the stored assistant message', () => {
  const streamed = appendStreamDelta(
    conversationFromTranscript(transcript({ messages: [], tools: [], mission: { summary: null, status: 'analyzing' } })),
    'The file exists.'
  )
  assert.equal(streamed[1]?.streaming, true)
  const stored = conversationFromTranscript(transcript())
  assert.equal(stored.find((entry) => entry.role === 'assistant' && entry.content.includes('The file exists.'))?.streaming, false)
  assert.equal(stored.filter((entry) => entry.role === 'assistant').length, 1)
})

test('mission history restoration keeps the conversation on that mission', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-conversation-'))
  const database = new MissionDatabase(path.join(root, 'kern.sqlite'))
  const session = database.createMission(root, 'Workspace')
  const mission = database.createAgentMission(root, 'Read note.txt')
  database.appendAgentMessage(mission.id, 'assistant', 'The file exists.')
  database.recordAgentTool({
    missionId: mission.id,
    callId: 'call-1',
    name: 'read_file',
    argumentsText: '{"path":"note.txt"}',
    state: 'finished',
    output: 'visible'
  })
  const restored = database.agentTranscript(mission.id)
  assert.ok(restored)
  const entries = conversationFromTranscript(restored)
  assert.equal(entries[0]?.role, 'user')
  assert.equal(entries[0]?.content, 'Read note.txt')
  assert.equal(entries.some((entry) => entry.content.includes('The file exists.')), true)
  assert.equal(entries.some((entry) => entry.activities.some((item) => item.name === 'read_file')), true)
  assert.equal(database.listMissions().some((item) => item.id === session.id && item.status === 'open'), true)
  database.close()
})

test('the conversation follows new messages until the reader scrolls upward', () => {
  assert.equal(shouldFollowTranscript(760, 1000, 200), true)
  assert.equal(shouldFollowTranscript(800, 1000, 200), true)
  assert.equal(shouldFollowTranscript(700, 1000, 200), false)
})

test('code blocks stay text and are split out of the prose', () => {
  const blocks = messageBlocks('See `note.txt`.\n```ts\nconst value = 1\n```\nDone')
  assert.equal(blocks[0]?.kind, 'text')
  assert.equal(blocks[0]?.text.includes('<'), false)
  assert.equal(blocks[1]?.kind, 'code')
  assert.equal(blocks[1]?.text, 'const value = 1')
  assert.equal(blocks[2]?.text, '\nDone')
})

test('chat keeps mission controls and uses timeline + single status bar markup', () => {
  assert.equal(panel.includes('Workspace sessions'), false)
  assert.equal(panel.includes('data-chat-history'), true)
  assert.equal(panel.includes('data-action="chat-new"'), true)
  assert.equal(panel.includes('data-mission-history'), true)
  assert.equal(panel.includes('data-conversation'), true)
  assert.equal(panel.includes('data-agent-status-bar'), true)
  assert.equal(panel.includes('data-timeline'), true)
  assert.equal(panel.includes('data-live-activity'), false)
  assert.equal(panel.includes('Idle / Ready'), false)
  assert.equal(panel.includes('Composer 2.5'), false)
  assert.equal(panel.includes('data-changes-bar'), true)
  assert.equal(panel.includes('data-context-chip'), true)
  assert.equal(panel.includes('data-message-role="tool"'), false)
  assert.equal(panel.includes('data-action="agent-cancel"'), true)
  assert.equal(panel.includes('data-action="agent-send"'), true)
  assert.equal(app.includes('history.missions'), true)
  assert.equal(app.includes('chat.hydrate'), true)
  assert.equal(app.includes('onSelectChat'), true)
  assert.equal(app.includes('createMission'), false)
})

test('send and cancel follow the existing mission rules', () => {
  assert.equal(canSend('  ', false, true), false)
  assert.equal(canSend('Inspect', true, true), false)
  assert.equal(canSend('Inspect', false, false), false)
  assert.equal(canSend('Inspect', false, true), true)
  assert.equal(composeOnEnter(false), 'send')
  assert.equal(composeOnEnter(true), 'newline')
  assert.equal(canCancel(true, 'analyzing'), true)
  assert.equal(canCancel(true, 'completed'), false)
  assert.equal(canCancel(false, 'executing'), false)
})
