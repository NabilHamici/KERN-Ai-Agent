import type { AgentTranscript } from '../../shared/agent'

export type ConversationEntry = {
  key: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  streaming: boolean
}

export type MessageBlock = { kind: 'text' | 'code'; text: string }

const CANCELLABLE = new Set(['queued', 'analyzing', 'planning', 'awaiting_approval', 'executing', 'verifying'])

export function conversationFromTranscript(transcript: AgentTranscript): ConversationEntry[] {
  const prompt = transcript.mission.prompt.trim()
  const entries: ConversationEntry[] = []
  if (prompt) {
    entries.push({ key: 'user', role: 'user', content: transcript.mission.prompt, streaming: false })
  }
  const timed: Array<{ at: string; seq: number; entry: ConversationEntry }> = []
  transcript.messages.forEach((message, index) => {
    if (message.role === 'user' && message.content.trim() === prompt) {
      return
    }
    const role = message.role === 'user' ? 'user' : 'assistant'
    timed.push({
      at: message.createdAt ?? '',
      seq: index,
      entry: { key: `message-${index}`, role, content: message.content, streaming: false }
    })
  })
  transcript.tools.forEach((tool, index) => {
    if (tool.name === 'submit_result') {
      return
    }
    timed.push({
      at: tool.createdAt ?? '',
      seq: 1_000 + index,
      entry: { key: `tool-${tool.callId}`, role: 'tool', content: toolLine(tool), streaming: false }
    })
  })
  const hasTime = timed.some((item) => item.at)
  timed.sort((left, right) => {
    if (hasTime && left.at !== right.at) {
      return left.at < right.at ? -1 : 1
    }
    return left.seq - right.seq
  })
  entries.push(...timed.map((item) => item.entry))
  const summary = transcript.mission.summary?.trim() ?? ''
  const lastAssistant = [...entries].reverse().find((entry) => entry.role === 'assistant')
  if (summary && summary !== lastAssistant?.content.trim()) {
    entries.push({ key: 'summary', role: 'assistant', content: transcript.mission.summary ?? '', streaming: false })
  }
  return entries
}

export function appendStreamDelta(entries: ConversationEntry[], delta: string): ConversationEntry[] {
  if (!delta) {
    return entries
  }
  const last = entries[entries.length - 1]
  if (last?.role === 'assistant' && last.streaming) {
    return [...entries.slice(0, -1), { ...last, content: last.content + delta }]
  }
  return [...entries, { key: `stream-${entries.length}`, role: 'assistant', content: delta, streaming: true }]
}

export function sealConversation(entries: ConversationEntry[]): ConversationEntry[] {
  if (!entries.some((entry) => entry.streaming)) {
    return entries
  }
  return entries.map((entry) => (entry.streaming ? { ...entry, streaming: false } : entry))
}

export function appendToolActivity(
  entries: ConversationEntry[],
  tool: { callId: string; name: string; argumentsText: string; state: string }
): ConversationEntry[] {
  const sealed = sealConversation(entries)
  if (tool.name === 'submit_result') {
    return sealed
  }
  const key = `tool-${tool.callId}`
  return [
    ...sealed.filter((entry) => entry.key !== key),
    { key, role: 'tool', content: toolLine(tool), streaming: false }
  ]
}

export function shouldFollowTranscript(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= 48
}

export function composeOnEnter(shiftKey: boolean): 'send' | 'newline' {
  return shiftKey ? 'newline' : 'send'
}

export function canSend(draft: string, running: boolean, workspaceOpen: boolean): boolean {
  return workspaceOpen && !running && draft.trim().length > 0
}

export function canCancel(running: boolean, status: string | null): boolean {
  return running && status !== null && CANCELLABLE.has(status)
}

export function showResponseIndicator(running: boolean, entries: ConversationEntry[]): boolean {
  if (!running) {
    return false
  }
  const last = entries[entries.length - 1]
  if (!last || last.role === 'user') {
    return true
  }
  return last.role === 'assistant' && last.streaming
}

export function messageBlocks(content: string): MessageBlock[] {
  const blocks: MessageBlock[] = []
  const parts = content.split('```')
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      if (part) {
        blocks.push({ kind: 'text', text: part })
      }
      return
    }
    const lineBreak = part.indexOf('\n')
    const code = lineBreak === -1 ? part : part.slice(lineBreak + 1)
    blocks.push({ kind: 'code', text: code.replace(/\n$/, '') })
  })
  return blocks
}

export function inlineParts(text: string): Array<{ code: boolean; text: string }> {
  return text
    .split('`')
    .map((part, index) => ({ code: index % 2 === 1, text: part }))
    .filter((part) => part.text.length > 0)
}

function toolLine(tool: { name: string; argumentsText: string; state: string }): string {
  const detail = toolDetail(tool.argumentsText)
  const label = detail ? `${tool.name} ${detail}` : tool.name
  return tool.state === 'rejected' ? `${label} rejected` : label
}

function toolDetail(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as { path?: unknown; query?: unknown }
    if (typeof parsed.path === 'string') {
      return parsed.path
    }
    if (typeof parsed.query === 'string') {
      return parsed.query
    }
  } catch {
    return ''
  }
  return ''
}
