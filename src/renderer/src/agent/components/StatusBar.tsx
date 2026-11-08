import { formatElapsed, type AgentUiStatus } from '../statusMachine.ts'

type StatusBarProps = {
  status: AgentUiStatus
  now: number
  cancellable: boolean
  onCancel: () => void
  onApprove?: () => void
  onDeny?: () => void
}

export function StatusBar({ status, now, cancellable, onCancel, onApprove, onDeny }: StatusBarProps) {
  const label = statusLine(status, now)
  return (
    <div className="agent-status-bar" data-agent-status-bar data-status-kind={status.kind} aria-live="polite">
      <span className="agent-status-bar-main">
        {status.kind === 'tool_running' || status.kind === 'thinking' || status.kind === 'stopping' ? (
          <span className="agent-spin" aria-hidden="true" />
        ) : (
          <span className={`agent-status-dot is-${status.kind}`} aria-hidden="true" />
        )}
        <span>{label}</span>
      </span>
      <span className="agent-status-bar-actions">
        {status.kind === 'awaiting_approval' ? (
          <>
            {onApprove ? (
              <button type="button" className="text-button" data-action="status-approve" onClick={onApprove}>
                Approve
              </button>
            ) : null}
            {onDeny ? (
              <button type="button" className="text-button" data-action="status-deny" onClick={onDeny}>
                Deny
              </button>
            ) : null}
          </>
        ) : null}
        {cancellable && (status.kind === 'thinking' || status.kind === 'tool_running' || status.kind === 'stopping') ? (
          <button type="button" className="compose-stop" data-action="agent-cancel" onClick={onCancel}>
            Stop
          </button>
        ) : null}
      </span>
    </div>
  )
}

function statusLine(status: AgentUiStatus, now: number): string {
  switch (status.kind) {
    case 'idle':
      return 'Ready'
    case 'thinking':
      return `${status.label} ${formatElapsed(status.startedAt, now)}`
    case 'tool_running': {
      const target = status.target ? `: ${status.target}` : ''
      return `${status.label}${target} · ${formatElapsed(status.startedAt, now)}`
    }
    case 'awaiting_approval':
      return `${status.label}: ${status.detail}`
    case 'stopping':
      return status.label
    case 'finished':
      return status.label
  }
}
