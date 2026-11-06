import { useState } from 'react'
import type { AgentMissionSummary, AgentToolRecord } from '../../../shared/agent'
import type { SessionRecord } from '../editorState'
import { Icon } from './Icons'

type FileChange = {
  relativePath: string
  changeType: string
  createdAt: string
  hasReverse?: boolean
}

type AgentPanelProps = {
  changes: FileChange[]
  sessions: SessionRecord[]
  providerReady: boolean
  workspaceOpen: boolean
  mission: AgentMissionSummary | null
  running: boolean
  text: string
  tools: AgentToolRecord[]
  history: AgentMissionSummary[]
  notice: string
  onSubmit: (prompt: string) => void
  onCancel: () => void
  onSelect: (missionId: string) => void
  onClose: () => void
}

const ACTIVE = new Set(['queued', 'analyzing', 'planning', 'awaiting_approval', 'executing', 'verifying'])

export function AgentPanel({
  changes,
  sessions,
  providerReady,
  workspaceOpen,
  mission,
  running,
  text,
  tools,
  history,
  notice,
  onSubmit,
  onCancel,
  onSelect,
  onClose
}: AgentPanelProps) {
  const [draft, setDraft] = useState('')
  const activeTool = [...tools].reverse().find((tool) => tool.state === 'started') ?? tools[tools.length - 1]
  const reads = tools.filter((tool) => tool.state === 'finished' && tool.name === 'read_file').map((tool) => tool.argumentsText)
  const statusLabel = mission ? mission.status.replaceAll('_', ' ') : 'Not running'

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
          {text ? <p className="agent-text">{text}</p> : null}
          {mission?.summary ? <p className="agent-text">{mission.summary}</p> : null}
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
        <section>
          <h2>Workspace sessions</h2>
          <p className="hint">These are saved workspace sessions, not live agent missions.</p>
          {sessions.length === 0 ? <p className="muted">No recorded sessions.</p> : null}
          {sessions.map((session) => (
            <div key={session.id} className="change-row">
              <span>{session.status}</span>
              <span>{session.title}</span>
              <span className="muted">{session.createdAt}</span>
            </div>
          ))}
        </section>
      </div>
      <div className="agent-compose">
        {!providerReady ? <p className="hint">Store a BharatCode API key in Settings before sending a mission.</p> : null}
        {!workspaceOpen ? <p className="hint">Open a folder before sending a mission.</p> : null}
        <div className="compose-box">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            placeholder="Tell KERN what to inspect in this workspace."
            spellCheck={false}
            disabled={!workspaceOpen || running}
          />
          <button
            type="button"
            className="send-button"
            disabled={!workspaceOpen || running || !draft.trim()}
            title={providerReady ? 'Send mission' : 'Store a BharatCode API key in Settings.'}
            onClick={() => {
              const prompt = draft.trim()
              if (!prompt) {
                return
              }
              setDraft('')
              onSubmit(prompt)
            }}
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
            <button type="button" className="text-button" data-action="agent-cancel" onClick={onCancel} disabled={!running || !mission || !ACTIVE.has(mission.status)}>
              Cancel
            </button>
          </div>
          <span>{running ? 'Running' : 'Not sent'}</span>
        </div>
      </div>
    </aside>
  )
}
