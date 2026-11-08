import { useState, type KeyboardEvent } from 'react'
import type { AgentOperationSummary } from '../../../../shared/agent.ts'
import { Icon } from '../../components/Icons'
import type { CommandStep, EditStep, TimelineStep } from '../timeline.ts'

const MAX_VISIBLE_LINES = 6
const MAX_DOM_LINES = 200

type ExpandProps = {
  open: boolean
  onToggle: () => void
  label: string
}

function ExpandButton({ open, onToggle, label }: ExpandProps) {
  return (
    <button
      type="button"
      className="step-expand"
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
    >
      <Icon name={open ? 'chevron-down' : 'chevron'} />
    </button>
  )
}

function StatusMark({ state }: { state: TimelineStep['state'] }) {
  if (state === 'running') return <span className="agent-spin step-mark" aria-hidden="true" />
  if (state === 'waiting') return <span className="step-mark is-wait" aria-hidden="true" />
  if (state === 'failed' || state === 'rejected') return <span className="step-mark is-fail" aria-hidden="true">✗</span>
  return <span className="step-mark is-ok" aria-hidden="true">✓</span>
}

export function StepGroupCard({
  label,
  count,
  steps
}: {
  label: string
  count: number
  steps: TimelineStep[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="step-group" data-step-group>
      <div className="step-row">
        <StatusMark state="success" />
        <span className="step-label">
          {label}
          <span className="muted"> · {count}</span>
        </span>
        <ExpandButton open={open} onToggle={() => setOpen((value) => !value)} label={label} />
      </div>
      {open ? (
        <ul className="step-group-list">
          {steps.map((step) => (
            <li key={step.id}>
              <StatusMark state={step.state} />
              <span>
                {step.label} {step.target}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function CommandCard({
  step,
  verification,
  onCancel,
  onOpenOutput
}: {
  step: CommandStep
  verification?: boolean
  onCancel?: () => void
  onOpenOutput?: (text: string) => void
}) {
  const [open, setOpen] = useState(step.state === 'running')
  const [showAll, setShowAll] = useState(false)
  const running = step.state === 'running'
  const output = [step.stdout, step.stderr].filter(Boolean).join('\n')
  const lines = output ? output.split('\n') : []
  const visible = running
    ? lines.slice(-MAX_VISIBLE_LINES)
    : showAll
      ? lines.slice(0, MAX_DOM_LINES)
      : [...lines.slice(0, 40), ...(lines.length > 80 ? ['… truncated …', ...lines.slice(-40)] : lines.slice(40))]

  return (
    <article
      className={`step-card is-command is-${step.state}${verification ? ' is-verification' : ''}`}
      data-step-card={verification ? 'verification' : 'command'}
      data-step-state={step.state}
    >
      <div className="step-row">
        <StatusMark state={step.state} />
        <div className="step-label">
          <code className="step-command">{step.command}</code>
          <span className="step-meta">
            {step.cwd ? `${step.cwd} · ` : ''}
            {running ? 'running' : step.exitCode !== null && step.exitCode !== undefined ? `exit ${step.exitCode}` : step.state}
            {typeof step.durationMs === 'number' ? ` · ${Math.max(1, Math.round(step.durationMs / 1000))}s` : ''}
            {step.retries ? ` · retried ×${step.retries}` : ''}
          </span>
          {step.error && !open ? <span className="step-error-preview">{step.error}</span> : null}
        </div>
        <ExpandButton open={open} onToggle={() => setOpen((value) => !value)} label={`Toggle ${step.command}`} />
      </div>
      {open ? (
        <div className="step-body">
          {step.diagnosis ? <p className="step-diagnosis" data-diagnosis>{step.diagnosis}</p> : null}
          {step.cwd ? <p className="muted">cwd {step.cwd}</p> : null}
          {step.stdout ? (
            <pre className="step-stdout" data-command-output>
              {(running ? step.stdout.split('\n').slice(-MAX_VISIBLE_LINES) : visible.filter((line) => !step.stderr?.includes(line)))
                .join('\n')
                .slice(0, 20_000)}
            </pre>
          ) : null}
          {step.stderr ? (
            <pre className="step-stderr" data-command-stderr>
              {step.stderr.split('\n').slice(0, showAll ? MAX_DOM_LINES : MAX_VISIBLE_LINES).join('\n')}
            </pre>
          ) : null}
          {!step.stdout && !step.stderr && output === '' ? <p className="muted">No output</p> : null}
          <div className="step-actions">
            {output ? (
              <button
                type="button"
                className="text-button"
                onClick={() => void navigator.clipboard.writeText(output)}
              >
                Copy output
              </button>
            ) : null}
            {lines.length > MAX_DOM_LINES && onOpenOutput ? (
              <button type="button" className="text-button" onClick={() => onOpenOutput(output)}>
                Show all
              </button>
            ) : lines.length > MAX_VISIBLE_LINES ? (
              <button type="button" className="text-button" onClick={() => setShowAll((value) => !value)}>
                {showAll ? 'Collapse' : 'Show more'}
              </button>
            ) : null}
            {running && onCancel ? (
              <button type="button" className="compose-stop" data-action="cancel-command" onClick={onCancel}>
                Stop
              </button>
            ) : null}
          </div>
          {step.attempts && step.attempts.length > 1 ? (
            <details className="step-attempts">
              <summary>Attempts ({step.attempts.length})</summary>
              <ul>
                {step.attempts.map((attempt, index) => (
                  <li key={`${step.id}-attempt-${index}`}>
                    {attempt.state}
                    {attempt.error ? `: ${attempt.error}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

export function EditCard({
  step,
  onReview,
  onUndo
}: {
  step: EditStep
  onReview?: (path: string) => void
  onUndo?: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <article className={`step-card is-edit is-${step.state}`} data-step-card="edit" data-step-state={step.state}>
      <div className="step-row">
        <StatusMark state={step.state} />
        <div className="step-label">
          <span>{step.label}</span>
          <span className="step-meta">
            {typeof step.additions === 'number' ? `+${step.additions}` : ''}
            {typeof step.deletions === 'number' ? ` −${step.deletions}` : ''}
            {step.retries ? ` · retried ×${step.retries}` : ''}
          </span>
          {step.error && !open ? <span className="step-error-preview">{step.error}</span> : null}
        </div>
        <div className="step-actions-inline">
          {onReview ? (
            <button type="button" className="text-button" onClick={() => onReview(step.path)}>
              Review
            </button>
          ) : null}
          {onUndo ? (
            <button type="button" className="text-button" onClick={() => onUndo(step.path)}>
              Undo
            </button>
          ) : null}
          <ExpandButton open={open} onToggle={() => setOpen((value) => !value)} label={`Toggle ${step.path}`} />
        </div>
      </div>
      {open ? (
        <div className="step-body">
          {step.diff ? (
            <pre className="proposal-diff">
              {step.diff.split('\n').slice(0, MAX_DOM_LINES).map((line, index) => (
                <span
                  key={`${step.id}-${index}`}
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
          ) : (
            <p className="muted">{step.path}</p>
          )}
          {step.attempts && step.attempts.length > 1 ? (
            <details className="step-attempts">
              <summary>Attempts ({step.attempts.length})</summary>
              <ul>
                {step.attempts.map((attempt, index) => (
                  <li key={`${step.id}-attempt-${index}`}>
                    {attempt.state}
                    {attempt.error ? `: ${attempt.error}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

export function ApprovalCard({
  operation,
  onApprove,
  onReject
}: {
  operation: AgentOperationSummary
  onApprove: (operationId: string) => void
  onReject: (operationId: string) => void
}) {
  const bulk = parseDeleteProposalSummary(operation.unifiedDiff)
  return (
    <article className="step-card is-approval" data-step-card="approval" data-proposal={operation.id}>
      <div className="step-row">
        <StatusMark state="waiting" />
        <div className="step-label">
          <span>{bulk?.title ?? `Delete ${operation.path}`}</span>
          <span className="step-meta risk">Requires approval</span>
        </div>
      </div>
      <p className="proposal-explain">{operation.explanation}</p>
      {bulk ? (
        <p className="muted">
          {bulk.files} files · {bulk.dirs} dirs · {bulk.bytes} B
        </p>
      ) : null}
      <pre className="proposal-diff">{operation.unifiedDiff.split('\n').slice(0, 80).join('\n')}</pre>
      <div className="proposal-actions">
        <button type="button" className="proposal-reject" data-action="agent-reject" onClick={() => onReject(operation.id)}>
          Deny
        </button>
        <button type="button" className="proposal-accept" data-action="agent-approve" onClick={() => onApprove(operation.id)}>
          Allow once
        </button>
      </div>
    </article>
  )
}

function parseDeleteProposalSummary(diff: string): { title: string; files: number; dirs: number; bytes: number } | null {
  const files = /Files:\s*(\d+)/i.exec(diff)
  const dirs = /Directories:\s*(\d+)/i.exec(diff)
  const bytes = /Bytes:\s*(\d+)/i.exec(diff)
  if (!files || !dirs || !bytes) return null
  const targetLine = /Delete proposal:\s*(.+)/i.exec(diff)?.[1]?.trim()
  return {
    title: targetLine || 'Bulk delete',
    files: Number(files[1]),
    dirs: Number(dirs[1]),
    bytes: Number(bytes[1])
  }
}
