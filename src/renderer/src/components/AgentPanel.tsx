import { useState } from 'react'
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
  onClose: () => void
}

export function AgentPanel({ changes, sessions, onClose }: AgentPanelProps) {
  const [draft, setDraft] = useState('')

  return (
    <aside className="agent">
      <div className="agent-head">
        <div className="agent-title">
          <span className="idle-dot" />
          <span>KERN AGENT</span>
          <span className="idle-badge" data-agent-status="idle">
            Idle
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
            <span>Not running</span>
          </div>
          <p className="mission-copy">No mission is in progress.</p>
          <div className="progress" title="No mission progress is available.">
            <i />
          </div>
        </section>
        <section>
          <h2>Execution action trace</h2>
          <p className="muted">No steps recorded. The agent runtime is not connected.</p>
        </section>
        <section className="tool-box">
          <header>
            <span>Active tool execution</span>
            <span>idle</span>
          </header>
          <p className="muted">No tool is running.</p>
        </section>
        <section>
          <h2>Context memory</h2>
          <p className="muted">None</p>
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
        <div className="compose-box">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            placeholder="Mission input stays on this device. Sending is unavailable."
            spellCheck={false}
          />
          <button type="button" className="send-button" disabled title="The agent runtime is not connected.">
            <Icon name="send" />
          </button>
        </div>
        <div className="compose-actions">
          <div>
            <button type="button" className="text-button" disabled title="No test runner is connected.">
              Run test
            </button>
            <button type="button" className="text-button" disabled title="No mission is running.">
              Pause
            </button>
          </div>
          <span>Not sent</span>
        </div>
      </div>
    </aside>
  )
}
