import { useState } from 'react'
import { TerminalPane } from '../TerminalPane'
import type { EditorDiagnostic } from '../EditorPane'
import { Icon } from './Icons'

type BottomPanelProps = {
  workspacePath: string | null
  diagnostics: EditorDiagnostic[]
  open: boolean
  onClose: () => void
  onCancel: () => void
}

export function BottomPanel({ workspacePath, diagnostics, open, onClose, onCancel }: BottomPanelProps) {
  const [tab, setTab] = useState<'terminal' | 'problems'>('terminal')
  const [clearRequest, setClearRequest] = useState(0)
  const [session, setSession] = useState(0)
  const [live, setLive] = useState(false)
  const errors = diagnostics.filter((item) => item.severity === 'error').length

  return (
    <section className={open ? 'bottom-panel' : 'bottom-panel collapsed'}>
      <div className="panel-bar">
        <div className="panel-tabs">
          <button type="button" className={tab === 'terminal' ? 'panel-tab active' : 'panel-tab'} onClick={() => setTab('terminal')}>
            <Icon name="terminal" />
            Terminal
          </button>
          <button type="button" className={tab === 'problems' ? 'panel-tab active' : 'panel-tab'} onClick={() => setTab('problems')}>
            <Icon name="alert" className={errors > 0 ? 'tone-amber' : 'tone-emerald'} />
            Problems ({diagnostics.length})
          </button>
          <button
            type="button"
            className="panel-tab"
            disabled
            title="There is no application output channel. The terminal shows the live PTY."
          >
            <Icon name="activity" className="tone-blue" />
            Output
          </button>
          <button type="button" className="panel-tab" disabled title="No test runner is connected.">
            <Icon name="check" className="tone-emerald" />
            Tests
          </button>
        </div>
        <div className="panel-tools">
          <button
            type="button"
            className="icon-hit"
            title="Clear terminal"
            onClick={() => setClearRequest((value) => value + 1)}
            disabled={!workspacePath || tab !== 'terminal'}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => setSession((value) => value + 1)}
            disabled={!workspacePath || live}
            title="Start the shell again after it exits"
          >
            Start
          </button>
          <button type="button" className="text-button" data-action="terminal-cancel" onClick={onCancel} disabled={!workspacePath || !live}>
            Cancel
          </button>
          <button type="button" className="icon-hit" title="Hide terminal" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div className="terminal-slot" hidden={tab !== 'terminal'}>
          <TerminalPane
            key={`${workspacePath ?? 'none'}:${session}`}
            workspacePath={workspacePath}
            clearRequest={clearRequest}
            onRunningChange={setLive}
          />
        </div>
        {tab === 'problems' ? (
          <div className="problems">
            {diagnostics.length === 0 ? (
              <p className="muted">No diagnostics for the open file. This list is Monaco’s markers, not a project lint.</p>
            ) : (
              diagnostics.map((item) => (
                <p key={`${item.startLine}:${item.startColumn}:${item.message}`} className={item.severity === 'error' ? 'problem error' : 'problem'}>
                  <span>{item.severity}</span>
                  {item.path}:{item.startLine}:{item.startColumn} {item.message}
                </p>
              ))
            )}
          </div>
        ) : null}
      </div>
    </section>
  )
}
