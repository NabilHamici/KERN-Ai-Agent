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
  messageBlocks,
  sealConversation,
  shouldFollowTranscript,
  showResponseIndicator
} from '../src/renderer/src/conversation.ts'
import type { AgentTranscript } from '../src/shared/agent.ts'

const panel = fs.readFileSync(new URL('../src/renderer/src/components/AgentPanel.tsx', import.meta.url), 'utf8')
const app = fs.readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')

function transcript(patch: {
  mission?: Partial<AgentTranscript['mission']>
  messages?: AgentTranscript['messages']
  tools?: AgentTranscript['tools']
} = {}): AgentTranscript {
  return {
    mission: {
      id: 'mission-1',
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

test('a restored mission shows the user prompt, assistant text, tool, and report in order', () => {
  const entries = conversationFromTranscript(transcript())
  assert.deepEqual(
    entries.map((entry) => [entry.role, entry.content]),
    [
      ['user', 'Read note.txt'],
      ['assistant', 'The file exists.'],
      ['tool', 'read_file note.txt'],
      ['assistant', 'Read note.txt']
    ]
  )
  assert.equal(entries.every((entry) => entry.streaming), false)
})

test('assistant streaming text grows one delta at a time and then seals', () => {
  let entries = conversationFromTranscript(transcript({ messages: [], tools: [], mission: { summary: null, status: 'analyzing' } }))
  assert.equal(entries[0]?.content, 'Read note.txt')
  assert.equal(showResponseIndicator(true, entries), true)
  entries = appendStreamDelta(entries, 'The ')
  entries = appendStreamDelta(entries, 'file exists.')
  assert.equal(entries[1]?.content, 'The file exists.')
  assert.equal(entries[1]?.streaming, true)
  assert.equal(showResponseIndicator(true, entries), true)
  entries = sealConversation(entries)
  entries = appendToolActivity(entries, { callId: 'call-1', name: 'read_file', argumentsText: '{"path":"note.txt"}', state: 'finished' })
  assert.equal(entries[1]?.streaming, false)
  assert.equal(entries[2]?.content, 'read_file note.txt')
  assert.equal(showResponseIndicator(false, entries), false)
})

test('the final transcript replaces the stream with the stored assistant message', () => {
  const streamed = appendStreamDelta(
    conversationFromTranscript(transcript({ messages: [], tools: [], mission: { summary: null, status: 'analyzing' } })),
    'The file exists.'
  )
  assert.equal(streamed[1]?.streaming, true)
  const stored = conversationFromTranscript(transcript())
  assert.equal(stored.find((entry) => entry.role === 'assistant' && entry.content === 'The file exists.')?.streaming, false)
  assert.equal(stored.at(-1)?.content, 'Read note.txt')
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
  assert.equal(entries.some((entry) => entry.content === 'The file exists.'), true)
  assert.equal(entries.some((entry) => entry.content === 'read_file note.txt'), true)
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

test('the workspace session box is gone and session loading remains', () => {
  assert.equal(panel.includes('Workspace sessions'), false)
  assert.equal(panel.includes('Active mission'), true)
  assert.equal(panel.includes('data-conversation'), true)
  assert.equal(panel.includes('data-action="agent-cancel"'), true)
  assert.equal(panel.includes('data-action="agent-send"'), true)
  assert.equal(app.includes('history.missions'), true)
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
