import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AgentMissionSummary, AgentOperationSummary, AgentToolRecord } from '../../../shared/agent'
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
  operations: AgentOperationSummary[]
  notice: string
  width: number
  onWidthChange: (width: number) => void
  onSubmit: (prompt: string) => void
  onCancel: () => void
  onApprove: (operationId: string) => void
  onReject: (operationId: string) => void
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
  operations,
  notice,
  width,
  onWidthChange,
  onSubmit,
  onCancel,
  onApprove,
  onReject,
  onClose
}: AgentPanelProps) {
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<'chat' | 'trace'>('chat')
  const [thoughtOpen, setThoughtOpen] = useState(true)
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
  const liveTitle = running ? `${activity.label}${activity.label.endsWith('...') ? '' : '...'}` : 'Idle / Ready'
  const liveDetailText = running ? liveDetail(activeTool, responding, notice) : 'Awaiting next user instruction'
  const thoughtTools = tools.filter((tool) => tool.name !== 'submit_result')

  useEffect(() => {
    follow.current = true
  }, [mission?.id])

  useEffect(() => {
    const node = scroller.current
    if (!node || !follow.current) {
      return
    }
    node.scrollTop = node.scrollHeight
  }, [messages, responding, operations, mission?.id])

  function submitDraft(): void {
    const prompt = draft.trim()
    if (!canSend(prompt, running, workspaceOpen)) {
      return
    }
    setDraft('')
    onSubmit(prompt)
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const handle = event.currentTarget
    const originX = event.clientX
    const originWidth = width
    handle.setPointerCapture(event.pointerId)
    const onMove = (moveEvent: PointerEvent): void => {
      const next = Math.round(originWidth + (originX - moveEvent.clientX))
      onWidthChange(Math.min(720, Math.max(300, next)))
    }
    const onUp = (upEvent: PointerEvent): void => {
      handle.releasePointerCapture(upEvent.pointerId)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('is-resizing-agent')
    }
    document.body.classList.add('is-resizing-agent')
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  return (
    <aside className="agent" style={{ width }}>
      <div className="agent-resize" role="separator" aria-orientation="vertical" aria-label="Resize agent sidebar" onPointerDown={beginResize} />
      <div className="agent-head">
        <div className="agent-title">
          <span className={running ? 'agent-mark is-live' : 'agent-mark'}>
            <SparkMark />
          </span>
          <div className="agent-brand">
            <span className="agent-brand-name">
              KERN AGENT
              <span className="idle-badge" data-agent-status={running ? 'running' : (mission?.status ?? 'idle')} data-activity={activity.phase}>
                {badge}
              </span>
            </span>
          </div>
        </div>
        <div className="agent-view" role="tablist" aria-label="Agent view">
          <button type="button" role="tab" aria-pressed={view === 'chat'} onClick={() => setView('chat')}>
            Chat
          </button>
          <button type="button" role="tab" aria-pressed={view === 'trace'} onClick={() => setView('trace')}>
            Trace
          </button>
        </div>
        <button type="button" className="icon-hit" title="Hide agent" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      <div className="agent-live" data-agent-live={running ? '' : undefined} data-activity={activity.phase}>
        {running ? <span className="agent-spin" /> : <Icon name="check" className="agent-live-check" />}
        <p>
          <strong>{liveTitle}</strong>
          <span>{liveDetailText}</span>
        </p>
      </div>

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
                  <span className={entry.role === 'user' ? 'chat-avatar is-user' : 'chat-avatar is-kern'}>
                    {entry.role === 'user' ? <UserMark /> : <SparkMark />}
                  </span>
                  {entry.role === 'user' ? (
                    <div className="chat-bubble is-user">
                      <MessageBody text={entry.content} />
                    </div>
                  ) : (
                    <div className="chat-assistant">
                      <MessageBody text={entry.content} />
                    </div>
                  )}
                </article>
              )
            )}

            {thoughtTools.length > 0 ? (
              <div className="thought-box">
                <button type="button" className="thought-toggle" onClick={() => setThoughtOpen((value) => !value)}>
                  <span>
                    <Icon name="cpu" />
                    Thought process ({thoughtTools.length} step{thoughtTools.length === 1 ? '' : 's'})
                  </span>
                  <Icon name={thoughtOpen ? 'chevron-down' : 'chevron'} />
                </button>
                {thoughtOpen ? (
                  <div className="thought-body">
                    {thoughtTools.map((tool) => (
                      <div key={tool.callId} className={tool.state === 'started' ? 'thought-step is-active' : 'thought-step'}>
                        <TraceState state={tool.state} />
                        <span>
                          {tool.name}
                          {tool.argumentsText ? ` · ${shortArgs(tool.argumentsText)}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {operations.map((operation) => (
              <ProposalCard key={operation.id} operation={operation} onApprove={onApprove} onReject={onReject} />
            ))}

            {responding ? (
              <p className="thread-wait" data-streaming="true">
                Responding
              </p>
            ) : null}
          </div>
        ) : (
          <section className="trace-panel" data-agent-trace>
            <div className="trace-head">
              <h2>Execution Timeline</h2>
              <span className="muted">{tools.length === 0 ? 'No steps' : `${tools.length} recorded`}</span>
            </div>
            {tools.length === 0 ? <p className="muted">No steps recorded.</p> : null}
            {tools.map((tool, index) => (
              <div key={tool.callId} className={tool.state === 'started' ? 'trace-card is-started' : 'trace-card'}>
                <div className="trace-card-main">
                  <TraceState state={tool.state} />
                  <div>
                    <p className="trace-title">{tool.name}</p>
                    <p className="muted">{tool.state}</p>
                    {tool.argumentsText ? <p className="muted">{shortArgs(tool.argumentsText)}</p> : null}
                  </div>
                </div>
                <span className="trace-index">Step {index + 1}</span>
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
            rows={2}
            placeholder="Tell KERN what to build or edit..."
            spellCheck={false}
            disabled={!workspaceOpen || running}
          />
          <div className="compose-footer">
            <div className="compose-tools">
              <button type="button" className="compose-icon" disabled title="Attachments are not available.">
                <PaperclipMark />
              </button>
              <button type="button" className="compose-icon" disabled title="Voice input is not available.">
                <MicMark />
              </button>
            </div>
            <button
              type="button"
              className="send-button"
              data-action="agent-send"
              disabled={!sendEnabled}
              title={providerReady ? 'Send mission' : 'Store a BharatCode API key in Settings.'}
              onClick={submitDraft}
            >
              <span>Send</span>
              <EnterMark />
            </button>
          </div>
        </div>
        <div className="compose-actions">
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
      </div>
    </aside>
  )
}

function ProposalCard({
  operation,
  onApprove,
  onReject
}: {
  operation: AgentOperationSummary
  onApprove: (operationId: string) => void
  onReject: (operationId: string) => void
}) {
  const stats = diffStats(operation.unifiedDiff)
  return (
    <article
      className={operation.destructive ? 'proposal-card is-destructive' : 'proposal-card'}
      data-proposal={operation.id}
      data-proposal-status={operation.status}
      data-proposals
    >
      <div className="proposal-head">
        <div className="proposal-path">
          <Icon name="file" />
          <span>
            {operation.path}
            {operation.toPath ? ` → ${operation.toPath}` : ''}
          </span>
        </div>
        <span className="proposal-stats">
          {stats.additions > 0 ? `+${stats.additions}` : '+0'}
          {stats.deletions > 0 ? ` -${stats.deletions}` : ' -0'}
        </span>
      </div>
      <div className="proposal-meta">
        <span>
          {operation.kind}
          {operation.destructive ? ' · destructive' : ''}
        </span>
        <span>{operation.status}</span>
      </div>
      <p className="proposal-explain">{operation.explanation}</p>
      {operation.error ? <p className="hint">{operation.error}</p> : null}
      <pre className="proposal-diff" data-proposal-diff={operation.id}>
        {operation.unifiedDiff.split('\n').map((line, index) => (
          <span
            key={`${operation.id}-${index}`}
            className={
              line.startsWith('+') && !line.startsWith('+++')
                ? 'diff-add'
                : line.startsWith('-') && !line.startsWith('---')
                  ? 'diff-del'
                  : line.startsWith('@@')
                    ? 'diff-hunk'
                    : undefined
            }
          >
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
      {operation.status === 'pending' ? (
        <div className="proposal-actions">
          <button type="button" className="proposal-reject" data-action="agent-reject" onClick={() => onReject(operation.id)}>
            <Icon name="close" />
            Reject
          </button>
          <button type="button" className="proposal-accept" data-action="agent-approve" onClick={() => onApprove(operation.id)}>
            <Icon name="check" />
            Accept Diff
          </button>
        </div>
      ) : null}
    </article>
  )
}

function liveDetail(tool: AgentToolRecord | undefined, responding: boolean, notice: string): string {
  if (notice) {
    return notice
  }
  if (tool && (tool.state === 'started' || tool.state === 'finished')) {
    return tool.argumentsText ? `${tool.name} ${shortArgs(tool.argumentsText)}` : tool.name
  }
  return responding ? 'Waiting for the model response.' : 'Mission is running.'
}

function shortArgs(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>
    if (typeof parsed.path === 'string') {
      return parsed.path
    }
    if (typeof parsed.query === 'string') {
      return parsed.query
    }
  } catch {
    return argumentsText.slice(0, 80)
  }
  return argumentsText.slice(0, 80)
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

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions += 1
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions += 1
    }
  }
  return { additions, deletions }
}

function SparkMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M8 1.5 9.2 5.8 13.5 7 9.2 8.2 8 12.5 6.8 8.2 2.5 7l4.3-1.2L8 1.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function UserMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="5.2" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.2 13c.6-2.4 2.2-3.6 4.8-3.6s4.2 1.2 4.8 3.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function PaperclipMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M9.2 3.6 4.4 8.4a2.5 2.5 0 0 0 3.5 3.5l5.2-5.2a1.7 1.7 0 0 0-2.4-2.4L5.6 9.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MicMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="6" y="2.2" width="4" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.2 8.2a3.8 3.8 0 0 0 7.6 0M8 12v1.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function EnterMark() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M3.2 4.2h7.2v5.2H5.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M6.8 7.2 5 9.2l1.8 2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
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
