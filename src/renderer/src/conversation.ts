import type { AgentChatTranscript, AgentTranscript } from '../../shared/agent'

export type ActivityState = 'running' | 'completed' | 'rejected' | 'awaiting_approval' | 'failed'

export type ResponseActivity = {
  key: string
  callId: string
  name: string
  detail: string
  state: ActivityState
  output?: string
  workingDirectory?: string
}

export type ConversationEntry = {
  key: string
  role: 'user' | 'assistant'
  content: string
  streaming: boolean
  activities: ResponseActivity[]
}

export type MessageBlock = { kind: 'text' | 'code'; text: string }

const CANCELLABLE = new Set(['queued', 'analyzing', 'planning', 'awaiting_approval', 'executing', 'verifying'])

export function conversationFromTranscript(transcript: AgentTranscript, keyPrefix = ''): ConversationEntry[] {
  const prefix = keyPrefix ? `${keyPrefix}-` : ''
  const prompt = transcript.mission.prompt.trim()
  const entries: ConversationEntry[] = []
  if (prompt) {
    entries.push({
      key: `${prefix}user`,
      role: 'user',
      content: transcript.mission.prompt,
      streaming: false,
      activities: []
    })
  }

  const assistantTexts: string[] = []
  for (const message of transcript.messages) {
    if (message.role === 'user' && message.content.trim() === prompt) {
      continue
    }
    if (message.role === 'assistant' || message.role === 'user') {
      const text = message.content.trim()
      if (text) {
        assistantTexts.push(message.content)
      }
    }
  }

  const activities = transcript.tools
    .filter((tool) => tool.name !== 'submit_result')
    .map((tool) => activityFromTool(tool))

  // Model prose only — never concatenate the mission ledger/report dump into Chat.
  // Legacy persisted messages that already contain ledger headers are split in the UI.
  const joined = assistantTexts.join('\n\n').trim()
  const content = stripLedgerFromAssistantContent(joined)

  if (content || activities.length > 0) {
    entries.push({
      key: `${prefix}assistant`,
      role: 'assistant',
      content,
      streaming: false,
      activities
    })
  }

  return entries
}

const LEDGER_LINE =
  /^(Proposed this mission|Applied this mission|Awaiting deletion approval|Awaiting approval|Failed operations|Rejected operations|Cancelled\/stale|Write confirmed by read|Commands:|Discovered during exploration|Mission progress based on|Note: reading a file after writing|Compact execution record:)/i

/** Split legacy assistant content that still embeds the mission ledger. */
export function splitAssistantReport(content: string): { prose: string; ledger: string | null } {
  const lines = content.split(/\n/)
  const prose: string[] = []
  const ledger: string[] = []
  let inLedger = false
  for (const line of lines) {
    if (LEDGER_LINE.test(line.trim())) {
      inLedger = true
    }
    if (inLedger) {
      ledger.push(line)
    } else {
      prose.push(line)
    }
  }
  return {
    prose: prose.join('\n').trim(),
    ledger: ledger.join('\n').trim() || null
  }
}

export function stripLedgerFromAssistantContent(content: string): string {
  return splitAssistantReport(content).prose
}

/** Stitch every mission turn in a chat into one chronological conversation. */
export function conversationFromChatTranscript(transcript: AgentChatTranscript): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  for (const turn of transcript.turns) {
    entries.push(...conversationFromTranscript(turn, turn.mission.id))
  }
  return entries
}

export function appendStreamDelta(entries: ConversationEntry[], delta: string): ConversationEntry[] {
  if (!delta) {
    return entries
  }
  const index = lastAssistantIndex(entries)
  if (index >= 0) {
    const current = entries[index]!
    const nextContent = current.content + delta
    if (hasRepeatedNarration(current.content, delta)) {
      return entries
    }
    return [
      ...entries.slice(0, index),
      { ...current, content: nextContent, streaming: true },
      ...entries.slice(index + 1)
    ]
  }
  return [
    ...entries,
    { key: `assistant-${entries.length}`, role: 'assistant', content: delta, streaming: true, activities: [] }
  ]
}

/** Drop near-identical progress lines the model repeats while exploring. */
export function hasRepeatedNarration(existing: string, delta: string): boolean {
  const incoming = delta.trim()
  if (incoming.length < 16) {
    return false
  }
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/[.…]+$/g, '').replace(/\s+/g, ' ').trim()
  const needle = normalize(incoming)
  const lines = existing
    .split(/\n+/)
    .map((line) => normalize(line))
    .filter(Boolean)
  if (lines.length === 0) {
    return false
  }
  const last = lines[lines.length - 1]!
  return last === needle
}

export function sealConversation(entries: ConversationEntry[]): ConversationEntry[] {
  if (!entries.some((entry) => entry.streaming)) {
    return entries
  }
  return entries.map((entry) => (entry.streaming ? { ...entry, streaming: false } : entry))
}

export function appendToolActivity(
  entries: ConversationEntry[],
  tool: { callId: string; name: string; argumentsText: string; state: string; output?: string }
): ConversationEntry[] {
  if (tool.name === 'submit_result') {
    return entries
  }
  const activity = activityFromTool({
    callId: tool.callId,
    name: tool.name,
    argumentsText: tool.argumentsText,
    state: tool.state === 'started' ? 'running' : tool.state === 'finished' ? 'success' : tool.state,
    output: tool.output
  })
  const index = lastAssistantIndex(entries)
  if (index >= 0) {
    const current = entries[index]!
    const activities = upsertActivity(current.activities, activity)
    return [...entries.slice(0, index), { ...current, activities }, ...entries.slice(index + 1)]
  }
  return [
    ...entries,
    {
      key: `assistant-${entries.length}`,
      role: 'assistant',
      content: '',
      streaming: false,
      activities: [activity]
    }
  ]
}

/** When the mission enters awaiting_approval, mark still-running tool rows. */
export function markActivityAwaitingApproval(entries: ConversationEntry[], callIds?: string[]): ConversationEntry[] {
  const wanted = callIds && callIds.length > 0 ? new Set(callIds) : null
  return entries.map((entry) => {
    if (entry.role !== 'assistant') {
      return entry
    }
    return {
      ...entry,
      activities: entry.activities.map((activity) => {
        if (activity.state !== 'running') {
          return activity
        }
        if (wanted && !wanted.has(activity.callId)) {
          return activity
        }
        return { ...activity, state: 'awaiting_approval' as const }
      })
    }
  })
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
  if (last.role === 'assistant' && (last.content.length > 0 || last.activities.length > 0 || last.streaming)) {
    return false
  }
  return true
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

export function toolDetail(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as {
      path?: unknown
      query?: unknown
      to?: unknown
      operationId?: unknown
      command?: unknown
      args?: unknown
    }
    if (typeof parsed.command === 'string') {
      const args = Array.isArray(parsed.args) ? parsed.args.filter((item) => typeof item === 'string').join(' ') : ''
      return [parsed.command, args].filter((part) => part.length > 0).join(' ')
    }
    if (typeof parsed.path === 'string') {
      return parsed.path
    }
    if (typeof parsed.to === 'string') {
      return parsed.to
    }
    if (typeof parsed.query === 'string') {
      return parsed.query
    }
    if (typeof parsed.operationId === 'string') {
      return parsed.operationId.slice(0, 8)
    }
  } catch {
    return ''
  }
  return ''
}

function lastAssistantIndex(entries: ConversationEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.role === 'assistant') {
      return index
    }
  }
  return -1
}

function upsertActivity(activities: ResponseActivity[], next: ResponseActivity): ResponseActivity[] {
  const existing = activities.findIndex((item) => item.callId === next.callId)
  if (existing === -1) {
    return [...activities, next]
  }
  return activities.map((item, index) => (index === existing ? next : item))
}

function activityFromTool(tool: {
  callId: string
  name: string
  argumentsText: string
  state: string
  output?: string
}): ResponseActivity {
  const state: ActivityState =
    tool.state === 'rejected'
      ? 'rejected'
      : tool.state === 'running' || tool.state === 'started'
        ? 'running'
        : tool.state === 'failed' || tool.state === 'cancelled' || tool.state === 'timed_out'
          ? 'failed'
          : tool.state === 'awaiting_approval'
            ? 'awaiting_approval'
            : 'completed'
  let workingDirectory: string | undefined
  try {
    const parsed = JSON.parse(tool.argumentsText) as { working_directory?: unknown }
    if (typeof parsed.working_directory === 'string' && parsed.working_directory.trim()) {
      workingDirectory = parsed.working_directory
    }
  } catch {
    workingDirectory = undefined
  }
  return {
    key: `tool-${tool.callId}`,
    callId: tool.callId,
    name: tool.name,
    detail: toolDetail(tool.argumentsText),
    state,
    output: tool.output,
    workingDirectory
  }
}
