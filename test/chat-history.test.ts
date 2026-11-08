import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentRuntime } from '../src/main/agent/runtime.ts'
import { MissionDatabase } from '../src/main/services/database.ts'
import { WorkspaceService } from '../src/main/services/workspace.ts'
import { chatTitleFromPrompt, type AgentEvent } from '../src/shared/agent.ts'
import type { ModelClient } from '../src/main/agent/loop.ts'
import type { ProviderTurn } from '../src/main/agent/provider.ts'
import { conversationFromChatTranscript } from '../src/renderer/src/conversation.ts'

function temporaryDirectory(prefix = 'kern-chat-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function harness(folder = temporaryDirectory()) {
  const dbPath = path.join(folder, 'kern.sqlite')
  const db = new MissionDatabase(dbPath)
  const workspace = new WorkspaceService(db)
  const info = workspace.open(folder)
  return { root: info.path, folder, dbPath, db, workspace }
}

function reopen(dbPath: string, expectedRoot: string) {
  const db = new MissionDatabase(dbPath)
  const workspace = new WorkspaceService(db)
  workspace.restore()
  assert.equal(workspace.current()?.path, fs.realpathSync(expectedRoot))
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => 'bc_chat_secret',
    emit: () => undefined
  })
  return { db, workspace, runtime }
}

function completion(summary = 'Done.'): ProviderTurn {
  return {
    kind: 'completed',
    output: [
      {
        type: 'function_call',
        call_id: 'finish',
        name: 'submit_result',
        arguments: JSON.stringify({ outcome: 'completed', summary })
      }
    ],
    calls: [
      {
        callId: 'finish',
        name: 'submit_result',
        arguments: JSON.stringify({ outcome: 'completed', summary })
      }
    ],
    text: '',
    requestId: 'req-finish'
  }
}

test('chatTitleFromPrompt truncates and cleans first line', () => {
  assert.equal(chatTitleFromPrompt('  Fix authentication bug  '), 'Fix authentication bug')
  assert.equal(
    chatTitleFromPrompt('Analyze database architecture\nwith more detail than belongs in a title'),
    'Analyze database architecture'
  )
  const long = 'x'.repeat(80)
  assert.equal(chatTitleFromPrompt(long).endsWith('…'), true)
  assert.ok(chatTitleFromPrompt(long).length <= 48)
})

test('create, rename, list, select, and archive chats in one workspace', async () => {
  const { root, db, workspace } = harness()
  const first = db.createAgentChat(root, 'New chat')
  assert.equal(first.title, 'New chat')
  const renamed = db.renameAgentChat(first.id, 'Fix authentication')
  assert.ok(renamed)
  assert.equal(renamed!.title, 'Fix authentication')
  assert.equal(renamed!.titleLocked, true)

  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = db.createAgentChat(root, 'Build settings screen')
  const listed = db.listAgentChatsForWorkspace(root)
  assert.equal(listed.length, 2)
  assert.equal(listed[0]!.id, second.id)

  workspace.setActiveChatId(first.id)
  db.setSelectedChatId(root, first.id)
  const transcript = db.agentChatTranscript(first.id)
  assert.ok(transcript)
  assert.equal(transcript!.chat.title, 'Fix authentication')
  assert.equal(transcript!.turns.length, 0)

  const archived = db.archiveAgentChat(first.id)
  assert.ok(archived?.archivedAt)
  assert.equal(db.listAgentChatsForWorkspace(root).some((chat) => chat.id === first.id), false)
  assert.ok(db.getAgentChat(first.id)?.archivedAt)
  db.close()
})

test('multiple missions stay inside one chat without duplicating messages', () => {
  const { root, db } = harness()
  const chat = db.createAgentChat(root, 'Improve authentication')
  const first = db.createAgentMission(root, 'Inspect authentication.', chat.id)
  db.appendAgentMessage(first.id, 'assistant', 'Found a potential issue')
  const second = db.createAgentMission(root, 'Fix token validation.', chat.id)
  db.appendAgentMessage(second.id, 'assistant', 'Prepared a modification')

  const transcript = db.agentChatTranscript(chat.id)
  assert.ok(transcript)
  assert.equal(transcript!.missions.length, 2)
  assert.equal(transcript!.turns.length, 2)
  assert.equal(transcript!.turns[0]!.mission.id, first.id)
  assert.equal(transcript!.turns[1]!.mission.id, second.id)
  assert.equal(transcript!.turns[0]!.messages.filter((item) => item.content === 'Found a potential issue').length, 1)
  assert.equal(transcript!.turns[1]!.messages.filter((item) => item.content === 'Found a potential issue').length, 0)

  const stitched = conversationFromChatTranscript(transcript!)
  assert.equal(stitched.filter((entry) => entry.role === 'user').length, 2)
  assert.equal(stitched.some((entry) => entry.content === 'Found a potential issue'), true)
  assert.equal(stitched.some((entry) => entry.content === 'Prepared a modification'), true)
  db.close()
})

test('new chat does not inherit prior chat context; same chat does', async () => {
  const { root, db, workspace } = harness()
  const chat = db.createAgentChat(root, 'Existing')
  const prior = db.createAgentMission(root, 'Prior work', chat.id)
  db.appendAgentMessage(prior.id, 'assistant', 'Secret from prior chat turn')
  db.setSelectedChatId(root, chat.id)
  workspace.setActiveChatId(chat.id)

  const events: AgentEvent[] = []
  let sawPrior = false
  let sawIsolation = false
  let turns = 0
  const client: ModelClient = async (input) => {
    turns += 1
    const serialized = JSON.stringify(input.input)
    if (turns === 1) {
      sawPrior = /Secret from prior chat turn/.test(serialized)
      return completion('Continued in same chat')
    }
    sawIsolation = !/Secret from prior chat turn/.test(serialized)
    return completion('Fresh chat reply')
  }
  const runtime = new AgentRuntime({
    database: db,
    workspace,
    readApiKey: async () => 'bc_chat_secret',
    emit: (event) => events.push(event),
    client
  })

  const same = await runtime.submit('Continue please', prior.id, chat.id)
  await runtime.finished()
  assert.equal(same.chatId, chat.id)
  assert.equal(sawPrior, true)

  const fresh = runtime.createChat()
  assert.equal(fresh.title, 'New chat')
  const next = await runtime.submit('Brand new request', undefined, fresh.id)
  await runtime.finished()
  assert.equal(next.chatId, fresh.id)
  assert.equal(sawIsolation, true)
  assert.notEqual(next.chatId, chat.id)

  const priorTranscript = db.agentChatTranscript(chat.id)
  assert.equal(priorTranscript!.turns.length, 2)
  const freshTranscript = db.agentChatTranscript(fresh.id)
  assert.equal(freshTranscript!.turns.length, 1)
  assert.equal(
    freshTranscript!.turns[0]!.messages.some((item) => item.content.includes('Secret')),
    false
  )
  db.close()
})

test('workspace chat lists and selected chat stay isolated', () => {
  const a = temporaryDirectory('kern-chat-a-')
  const b = temporaryDirectory('kern-chat-b-')
  const dbPath = path.join(a, 'shared.sqlite')
  const db = new MissionDatabase(dbPath)
  const workspace = new WorkspaceService(db)

  const workspaceA = workspace.open(a).path
  const chatA = db.createAgentChat(workspaceA, 'KERN chat')
  db.createAgentMission(workspaceA, 'Work in A', chatA.id)
  db.setSelectedChatId(workspaceA, chatA.id)

  const workspaceB = workspace.open(b).path
  const chatB = db.createAgentChat(workspaceB, 'FreeLaZone chat')
  db.createAgentMission(workspaceB, 'Work in B', chatB.id)
  db.setSelectedChatId(workspaceB, chatB.id)

  assert.equal(db.listAgentChatsForWorkspace(workspaceA).length, 1)
  assert.equal(db.listAgentChatsForWorkspace(workspaceA)[0]!.id, chatA.id)
  assert.equal(db.listAgentChatsForWorkspace(workspaceB).length, 1)
  assert.equal(db.listAgentChatsForWorkspace(workspaceB)[0]!.id, chatB.id)
  assert.equal(db.agentChatBelongsToWorkspace(chatA.id, workspaceB), false)
  assert.equal(db.agentChatBelongsToWorkspace(chatB.id, workspaceA), false)

  workspace.open(a)
  assert.equal(workspace.activeChatId(), chatA.id)
  workspace.open(b)
  assert.equal(workspace.activeChatId(), chatB.id)
  db.close()
})

test('hydrate restores selected chat and leaves interrupted missions interrupted', () => {
  const { root, dbPath, db } = harness()
  const chat = db.createAgentChat(root, 'Hydrate me')
  const first = db.createAgentMission(root, 'First turn', chat.id)
  db.appendAgentMessage(first.id, 'assistant', 'First answer')
  db.transitionAgentMission(first.id, 'analyzing', { summary: null, error: null })
  db.interruptAgentMissions()
  assert.equal(db.getAgentMission(first.id)?.status, 'interrupted')
  db.setSelectedChatId(root, chat.id)
  db.close()

  const again = reopen(dbPath, root)
  const hydrated = again.runtime.hydrateChat()
  assert.ok(hydrated)
  assert.equal(hydrated!.chat.id, chat.id)
  assert.equal(hydrated!.turns.length, 1)
  assert.equal(hydrated!.turns[0]!.mission.status, 'interrupted')
  assert.equal(again.runtime.current(), null)
  const againHydrated = again.runtime.hydrateChat()
  assert.equal(againHydrated!.chat.id, chat.id)
  assert.equal(againHydrated!.turns.length, 1)
  again.db.close()
})

test('legacy migration creates one chat per orphan mission and preserves records', async () => {
  const folder = temporaryDirectory('kern-chat-legacy-')
  const dbPath = path.join(folder, 'kern.sqlite')
  const first = new MissionDatabase(dbPath)
  const root = fs.realpathSync(folder)
  const missionA = first.createAgentMission(root, 'Analyze project structure')
  const missionB = first.createAgentMission(root, 'Build settings screen')
  first.appendAgentMessage(missionA.id, 'assistant', 'Legacy answer A')
  first.appendAgentMessage(missionB.id, 'assistant', 'Legacy answer B')
  const chatIds = [missionA.chatId, missionB.chatId].filter(Boolean) as string[]
  first.close()

  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(dbPath)
  raw.exec('PRAGMA foreign_keys = ON')
  raw.prepare('UPDATE agent_missions SET chat_id = NULL').run()
  for (const chatId of chatIds) {
    raw.prepare('DELETE FROM agent_chats WHERE id = ?').run(chatId)
  }
  raw.close()

  const again = new MissionDatabase(dbPath)
  const chatA = again.getAgentMission(missionA.id)?.chatId
  const chatB = again.getAgentMission(missionB.id)?.chatId
  assert.ok(chatA)
  assert.ok(chatB)
  assert.notEqual(chatA, chatB)
  assert.equal(again.getAgentChat(chatA!)?.title.includes('Analyze project structure'), true)
  assert.equal(again.agentChatTranscript(chatA!)?.turns[0]?.messages.some((item) => item.content === 'Legacy answer A'), true)
  assert.equal(again.agentChatTranscript(chatB!)?.turns[0]?.messages.some((item) => item.content === 'Legacy answer B'), true)
  assert.equal(again.listAgentChatsForWorkspace(root).length >= 2, true)
  again.close()
})

test('file-change review stays scoped to the active chat', () => {
  const { root, db, workspace } = harness()
  const chatA = db.createAgentChat(root, 'Chat A')
  const chatB = db.createAgentChat(root, 'Chat B')
  workspace.setActiveChatId(chatA.id)
  fs.writeFileSync(path.join(root, 'a.txt'), 'a')
  workspace.write('a.txt', 'alpha')
  workspace.setActiveChatId(chatB.id)
  fs.writeFileSync(path.join(root, 'b.txt'), 'b')
  workspace.write('b.txt', 'beta')

  const openA = workspace.listFileChanges(20, 'open', chatA.id)
  const openB = workspace.listFileChanges(20, 'open', chatB.id)
  assert.equal(openA.some((item) => item.relativePath === 'a.txt'), true)
  assert.equal(openA.some((item) => item.relativePath === 'b.txt'), false)
  assert.equal(openB.some((item) => item.relativePath === 'b.txt'), true)
  assert.equal(openB.some((item) => item.relativePath === 'a.txt'), false)

  workspace.setActiveChatId(chatA.id)
  const kept = workspace.keepFileChanges()
  assert.ok(kept.kept.length >= 1)
  assert.equal(workspace.listFileChanges(20, 'open', chatA.id).length, 0)
  assert.equal(workspace.listFileChanges(20, 'open', chatB.id).some((item) => item.relativePath === 'b.txt'), true)
  db.close()
})

test('AgentPanel exposes chat history controls', () => {
  const panel = [
    fs.readFileSync(new URL('../src/renderer/src/components/AgentPanel.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/renderer/src/agent/components/HistoryMenu.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/renderer/src/agent/components/Timeline.tsx', import.meta.url), 'utf8')
  ].join('\n')
  assert.match(panel, /data-chat-history/)
  assert.match(panel, /data-action="chat-new"/)
  assert.match(panel, /onNewChat/)
  assert.match(panel, /onSelectChat/)
  assert.match(panel, /onRenameChat/)
  assert.match(panel, /onArchiveChat/)
  assert.match(panel, /data-empty-chat/)
})
