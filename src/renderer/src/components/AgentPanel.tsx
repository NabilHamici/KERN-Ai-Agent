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
  history: AgentMissionSummary[]
  notice: string
  onSubmit: (prompt: string) => void
  onCancel: () => void
  onSelect: (missionId: string) => void
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
  history,
  notice,
  onSubmit,
  onCancel,
  onSelect,
  onClose
}: AgentPanelProps) {
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const activeTool = [...tools].reverse().find((tool) => tool.state === 'started') ?? tools[tools.length - 1]
  const reads = tools.filter((tool) => tool.state === 'finished' && tool.name === 'read_file').map((tool) => tool.argumentsText)
  const statusLabel = mission ? mission.status.replaceAll('_', ' ') : 'Not running'
  const responding = showResponseIndicator(running, messages)
  const sendEnabled = canSend(draft, running, workspaceOpen)

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
          <span className="idle-badge" data-agent-status={running ? 'running' : 'idle'}>
            {running ? 'Running' : 'Idle'}
          </span>
        </div>
        <button type="button" className="icon-hit" title="Hide agent" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="agent-scroll">
        <section className="mission-card">
          <div className="card-top">
            <span>Active mission</span>
            <span>{statusLabel}</span>
          </div>
          <p className="mission-copy">{mission?.prompt ?? 'No mission is in progress.'}</p>
          {notice ? <p className="hint">{notice}</p> : null}
          <div className="progress" title="Progress is not estimated. The status above is the persisted mission state.">
            <i />
          </div>
        </section>
        <section>
          <h2>Execution action trace</h2>
          {tools.length === 0 ? <p className="muted">No steps recorded.</p> : null}
          {tools.map((tool) => (
            <div key={tool.callId} className="change-row">
              <span>{tool.state}</span>
              <span>{tool.name}</span>
              <span className="muted">{tool.argumentsText}</span>
            </div>
          ))}
        </section>
        <section className="tool-box">
          <header>
            <span>Active tool execution</span>
            <span>{activeTool?.name ?? 'idle'}</span>
          </header>
          {activeTool ? <pre>{activeTool.output || activeTool.argumentsText}</pre> : <p className="muted">No tool is running.</p>}
        </section>
        <section>
          <h2>Context memory</h2>
          {reads.length === 0 ? <p className="muted">None</p> : null}
          {reads.map((entry) => (
            <p key={entry} className="change-row">
              {entry}
            </p>
          ))}
        </section>
        <section>
          <h2>Agent missions</h2>
          {history.length === 0 ? <p className="muted">No agent missions yet.</p> : null}
          {history.map((item) => (
            <button key={item.id} type="button" className="change-row" onClick={() => onSelect(item.id)}>
              <span>{item.status}</span>
              <span>{item.title}</span>
              <span className="muted">{item.createdAt}</span>
            </button>
          ))}
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
      <div
        className="conversation"
        data-conversation
        ref={scroller}
        onScroll={() => {
          const node = scroller.current
          if (!node) {
            return
          }
          follow.current = shouldFollowTranscript(node.scrollTop, node.scrollHeight, node.clientHeight)
        }}
      >
        {messages.length === 0 ? <p className="muted">No conversation yet.</p> : null}
        {messages.map((entry) => (
          <article key={entry.key} className={`thread-line is-${entry.role}`} data-message-role={entry.role}>
            <span className="thread-role">{entry.role === 'user' ? 'You' : entry.role === 'tool' ? 'Tool' : 'KERN'}</span>
            {entry.role === 'tool' ? <p className="thread-copy">{entry.content}</p> : <MessageBody text={entry.content} />}
          </article>
        ))}
        {responding ? (
          <p className="thread-wait" data-streaming="true">
            Responding
          </p>
        ) : null}
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
            placeholder="Tell KERN what to inspect in this workspace."
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
          <span>{running ? 'Running' : 'Not sent'}</span>
        </div>
      </div>
    </aside>
  )
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
