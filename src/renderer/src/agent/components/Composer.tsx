import { useRef, type KeyboardEvent } from 'react'
import type { ProviderId } from '../../../../shared/provider.ts'
import { modelDisplayName } from '../../../../shared/provider.ts'
import { canCancel, canSend, composeOnEnter } from '../../conversation.ts'
import type { MissionStatus } from '../../../../shared/agent.ts'
import { ContextChip } from './ContextChip.tsx'

type ComposerProps = {
  draft: string
  onDraftChange: (value: string) => void
  running: boolean
  workspaceOpen: boolean
  providerReady: boolean
  providerDetail: string
  providerId: ProviderId
  missionStatus: MissionStatus | null
  contextPaths: string[]
  onSubmit: () => void
  onCancel: () => void
  onProviderChange: (provider: ProviderId) => void
}

export function Composer({
  draft,
  onDraftChange,
  running,
  workspaceOpen,
  providerReady,
  providerDetail,
  providerId,
  missionStatus,
  contextPaths,
  onSubmit,
  onCancel,
  onProviderChange
}: ComposerProps) {
  const composeRef = useRef<HTMLTextAreaElement>(null)
  const sendEnabled = canSend(draft, running, workspaceOpen)

  return (
    <div className="agent-compose" data-agent-composer>
      {providerDetail ? <p className="hint">{providerDetail}</p> : null}
      {!workspaceOpen ? <p className="hint">Open a folder before sending a mission.</p> : null}
      <div className="compose-shell">
        <textarea
          ref={composeRef}
          value={draft}
          onChange={(event) => {
            onDraftChange(event.target.value)
            const node = event.currentTarget
            node.style.height = 'auto'
            node.style.height = `${Math.min(180, Math.max(72, node.scrollHeight))}px`
          }}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
              return
            }
            if (composeOnEnter(event.shiftKey) === 'newline') {
              return
            }
            event.preventDefault()
            onSubmit()
          }}
          rows={3}
          placeholder="Plan, build, ask KERN…"
          spellCheck={false}
          disabled={!workspaceOpen || running}
          data-composer
        />
        <div className="compose-toolbar">
          <div className="compose-chips">
            <span className="compose-chip" title="Destructive changes require approval">
              Agent · approvals
            </span>
            <label className="compose-chip is-select">
              <select
                value={providerId}
                disabled={running}
                aria-label="Model"
                onChange={(event) => onProviderChange(event.target.value as ProviderId)}
              >
                <option value="bharatcode">{modelDisplayName('bharatcode')}</option>
                <option value="cursor">{modelDisplayName('cursor')}</option>
              </select>
            </label>
            <ContextChip paths={contextPaths} />
          </div>
          <div className="compose-actions-row">
            {running ? (
              <button
                type="button"
                className="compose-stop"
                data-action="agent-cancel"
                onClick={onCancel}
                disabled={!canCancel(running, missionStatus)}
                title="Cancel mission"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="compose-send"
                data-action="agent-send"
                disabled={!sendEnabled}
                title={providerReady ? 'Send mission' : 'Configure a provider in Settings.'}
                onClick={onSubmit}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
