import { useEffect, useRef, useState } from 'react'
import type { AgentMissionSummary, AgentToolRecord } from '../../../shared/agent'
import {
  canCancel,
  canSend,
  composeOnEnter,
  inlineParts,
  messageBlocks,
  shouldFollowTranscript,
  showResponseIndicator,
  type ConversationEntry
} from '../conversation'
import { agentActivity } from '../activity'
import { Icon } from './Icons'

type FileChange = {
  relativePath: string
  changeType: string
  createdAt: string
  hasReverse?: boolean
}

type AgentPanelProps = {
  changes: FileChange[]
  providerReady: boolean
  providerDetail: string
  workspaceOpen: boolean
  mission: AgentMissionSummary | null
  running: boolean
  messages: ConversationEntry[]
  tools: AgentToolRecord[]
  notice: string
  onSubmit: (prompt: string) => void
  onCancel: () => void
  onClose: () => void
}

export function AgentPanel({
  changes,
  providerReady,
  providerDetail,
  workspaceOpen,
  mission,
  running,
  messages,
  tools,
  notice,
  onSubmit,
  onCancel,
  onClose
}: AgentPanelProps) {
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<'chat' | 'trace'>('chat')
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const startedTool = [...tools].reverse().find((tool) => tool.state === 'started')
  const activeTool = startedTool ?? tools[tools.length - 1]
  const activity = agentActivity({
    running,
    status: mission?.status ?? null,
    toolName: startedTool?.name ?? null,
    toolState: startedTool?.state ?? null
  })
  const pins = [
    ...new Set(
      tools
        .filter((tool) => tool.state === 'finished' && tool.name === 'read_file')
        .map((tool) => pinLabel(tool.argumentsText))
        .filter((label) => label.length > 0)
    )
  ]
  const statusLabel = mission ? mission.status.replaceAll('_', ' ') : 'Not running'
  const responding = showResponseIndicator(running, messages)
  const sendEnabled = canSend(draft, running, workspaceOpen)
  const badge = running ? activity.label : mission ? statusLabel : 'Idle'

  useEffect(() => {
    follow.current = true
  }, [mission?.id])

  useEffect(() => {
    const node = scroller.current
    if (!node || !follow.current) {
      return
    }
    node.scrollTop = node.scrollHeight
  }, [messages, responding, mission?.id])

  function submitDraft(): void {
    const prompt = draft.trim()
    if (!canSend(prompt, running, workspaceOpen)) {
      return
    }
    setDraft('')
    onSubmit(prompt)
  }

  return (
    <aside className="agent">
      <div className="agent-head">
        <div className="agent-title">
          <span className={running ? 'idle-dot is-live' : 'idle-dot'} />
          <span>KERN AGENT</span>
          <span className="idle-badge" data-agent-status={running ? 'running' : (mission?.status ?? 'idle')} data-activity={activity.phase}>
            {badge}
          </span>
        </div>
        <div className="agent-view" role="tablist" aria-label="Agent view">
          <button type="button" role="tab" aria-pressed={view === 'chat'} onClick={() => setView('chat')}>
            <ChatMark />
            Chat
          </button>
          <button type="button" role="tab" aria-pressed={view === 'trace'} onClick={() => setView('trace')}>
            <TraceMark />
            Trace
          </button>
        </div>
        <button type="button" className="icon-hit" title="Hide agent" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {running ? (
        <div className="agent-live" data-agent-live data-activity={activity.phase}>
          <span className="agent-spin" />
          <p>
            <strong>{activity.label}</strong>
            <span>{liveDetail(activeTool, responding, notice)}</span>
          </p>
        </div>
      ) : null}
      <div
        className="agent-scroll"
        ref={scroller}
        onScroll={() => {
          const node = scroller.current
          if (!node) {
            return
          }
          follow.current = shouldFollowTranscript(node.scrollTop, node.scrollHeight, node.clientHeight)
        }}
      >
        <section className="mission-card">
          <div className="card-top">
            <span>Active mission</span>
            <span>{statusLabel}</span>
          </div>
          <p className="mission-copy">{mission?.prompt ?? 'No mission is in progress.'}</p>
          {notice ? <p className="hint">{notice}</p> : null}
          <div
            className="progress"
            data-progress={activity.progress === null ? 'unestimated' : 'reported'}
            title="Progress is not estimated. The status above is the persisted mission state."
          >
            <i />
          </div>
        </section>
        {view === 'chat' ? (
          <div className="conversation" data-conversation>
            {messages.length === 0 ? <p className="muted">No conversation yet.</p> : null}
            {messages.map((entry) =>
              entry.role === 'tool' ? (
                <p key={entry.key} className="chat-tool" data-message-role="tool">
                  {entry.content}
                </p>
              ) : (
                <article key={entry.key} className="chat-row" data-message-role={entry.role}>
                  <span className={entry.role === 'user' ? 'chat-avatar is-user' : 'chat-avatar is-kern'}>{entry.role === 'user' ? 'U' : 'K'}</span>
                  <div className="chat-bubble">
                    <MessageBody text={entry.content} />
                  </div>
                </article>
              )
            )}
            {responding ? (
              <p className="thread-wait" data-streaming="true">
                Responding
              </p>
            ) : null}
          </div>
        ) : (
          <section data-agent-trace>
            <div className="trace-head">
              <h2>Execution action trace</h2>
              <span className="muted">{tools.length === 0 ? 'No steps' : `${tools.length} recorded`}</span>
            </div>
            {tools.length === 0 ? <p className="muted">No steps recorded.</p> : null}
            {tools.map((tool) => (
              <div key={tool.callId} className={tool.state === 'started' ? 'trace-step is-started' : 'trace-step'}>
                <TraceState state={tool.state} />
                <div>
                  <p>
                    <strong>{tool.name}</strong>
                  </p>
                  <p className="muted">{tool.state}</p>
                  {tool.argumentsText ? <p className="muted">{tool.argumentsText}</p> : null}
                </div>
              </div>
            ))}
            <section className="tool-box">
              <header>
                <span>Active tool execution</span>
                <span>{activeTool?.name ?? 'idle'}</span>
              </header>
              {activeTool ? <pre>{activeTool.output || activeTool.argumentsText}</pre> : <p className="muted">No tool is running.</p>}
            </section>
          </section>
        )}
        <section>
          <h2>Context pins</h2>
          {pins.length === 0 ? <p className="muted">None</p> : null}
          <div className="pin-row">
            {pins.map((pin) => (
              <span key={pin} className="pin">
                <Icon name="file" />
                {pin}
              </span>
            ))}
          </div>
        </section>
        <section>
          <h2>Recorded file changes</h2>
          <p className="hint">Summaries come from the local mission history. Diff text is not exposed to the renderer.</p>
          {changes.length === 0 ? <p className="muted">No saved changes yet.</p> : null}
          {changes.map((change) => (
            <div key={`${change.createdAt}-${change.relativePath}`} className="change-row" data-file-change={change.relativePath}>
              <span>{change.changeType}</span>
              <span>{change.relativePath}</span>
              <span className="muted">{change.hasReverse ? 'previous text kept' : 'no reverse text'}</span>
            </div>
          ))}
        </section>
      </div>
      <div className="agent-compose">
        {providerDetail ? <p className="hint">{providerDetail}</p> : null}
        {!workspaceOpen ? <p className="hint">Open a folder before sending a mission.</p> : null}
        <div className="compose-box">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
                return
              }
              if (composeOnEnter(event.shiftKey) === 'newline') {
                return
              }
              event.preventDefault()
              submitDraft()
            }}
            rows={3}
            placeholder="Tell KERN what to build or refactor..."
            spellCheck={false}
            disabled={!workspaceOpen || running}
          />
          <button
            type="button"
            className="send-button"
            data-action="agent-send"
            disabled={!sendEnabled}
            title={providerReady ? 'Send mission' : 'Store a BharatCode API key in Settings.'}
            onClick={submitDraft}
          >
            <Icon name="send" />
          </button>
        </div>
        <div className="compose-actions">
          <div>
            <button type="button" className="text-button" disabled title="No test runner is connected.">
              Run test
            </button>
            <button type="button" className="text-button" disabled title="Pause is not available.">
              Pause
            </button>
            <button type="button" className="text-button" data-action="agent-cancel" onClick={onCancel} disabled={!canCancel(running, mission?.status ?? null)}>
              Cancel
            </button>
          </div>
          <span className="compose-hint">{running ? 'Running' : 'Shift + Enter for line'}</span>
        </div>
      </div>
    </aside>
  )
}

function liveDetail(tool: AgentToolRecord | undefined, responding: boolean, notice: string): string {
  if (notice) {
    return notice
  }
  if (tool && (tool.state === 'started' || tool.state === 'finished')) {
    return tool.argumentsText ? `${tool.name} ${tool.argumentsText}` : tool.name
  }
  return responding ? 'Waiting for the model response.' : 'Mission is running.'
}

function pinLabel(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as { path?: unknown }
    if (typeof parsed.path === 'string') {
      return parsed.path
    }
  } catch {
    return argumentsText
  }
  return argumentsText
}

function ChatMark() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M2.5 3.5h11v7.2H6.2L3.2 13V3.5Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function TraceMark() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M3 4.2h10M3 8h10M3 11.8h7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function TraceState({ state }: { state: AgentToolRecord['state'] }) {
  if (state === 'started') {
    return <span className="agent-spin trace-mark" />
  }
  if (state === 'finished') {
    return <Icon name="check" className="trace-mark is-done" />
  }
  return <span className="trace-mark is-rejected" aria-hidden="true" />
}

function MessageBody({ text }: { text: string }) {
  return (
    <div className="thread-body">
      {messageBlocks(text).map((block, index) =>
        block.kind === 'code' ? (
          <pre key={index} className="thread-code">
            {block.text}
          </pre>
        ) : (
          <p key={index} className="thread-copy">
            {inlineParts(block.text).map((part, partIndex) =>
              part.code ? <code key={partIndex}>{part.text}</code> : <span key={partIndex}>{part.text}</span>
            )}
          </p>
        )
      )}
    </div>
  )
}
