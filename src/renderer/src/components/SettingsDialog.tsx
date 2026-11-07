import type { ConnectionState, ProviderId } from '../../../shared/provider'

type SettingsDialogProps = {
  open: boolean
  provider: ProviderId
  connectionState: ConnectionState
  detail: string
  secretDraft: string
  onProvider: (provider: ProviderId) => void
  onDraft: (value: string) => void
  onSave: () => void
  onClear: () => void
  onCheck: () => void
  onClose: () => void
}

export function SettingsDialog({
  open,
  provider,
  connectionState,
  detail,
  secretDraft,
  onProvider,
  onDraft,
  onSave,
  onClear,
  onCheck,
  onClose
}: SettingsDialogProps) {
  return (
    <div className="settings-layer" hidden={!open}>
      <div className="settings-card" role="dialog" aria-labelledby="settings-title">
        <div className="pane-title">
          <h2 id="settings-title">Settings</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <label className="secret-field">
          Model provider
          <select value={provider} data-provider-select onChange={(event) => onProvider(event.target.value as ProviderId)}>
            <option value="bharatcode">BharatCode</option>
            <option value="cursor">Cursor</option>
          </select>
        </label>
        <p className="hint" data-provider-connection data-connection-state={connectionState}>
          {detail}
        </p>
        <p className="hint">
          BharatCode is the default and still uses its own saved key. Cursor uses the login already stored by the Cursor SDK on this Mac, the same way the interview app does. Composer 2.5 stays on the included plan pool. Check does not start a mission.
        </p>
        <button type="button" className="text-button" data-action="provider-check" onClick={onCheck}>
          Check connection
        </button>
        <label className="secret-field">
          BharatCode API key
          <input
            data-secret-input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={secretDraft}
            placeholder="Enter a key to store"
            onChange={(event) => onDraft(event.target.value)}
          />
        </label>
        <div className="settings-actions">
          <button type="button" className="text-button" data-action="secret-save" onClick={onSave} disabled={!secretDraft}>
            Save key
          </button>
          <button type="button" className="text-button" data-action="secret-clear" onClick={onClear}>
            Clear
          </button>
        </div>
        <p className="hint">The BharatCode key is encrypted on this Mac and used only by the main process. Its value never returns to this window.</p>
      </div>
    </div>
  )
}
