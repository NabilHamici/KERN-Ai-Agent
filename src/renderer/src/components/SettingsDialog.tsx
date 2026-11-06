type SettingsDialogProps = {
  open: boolean
  secretDraft: string
  onDraft: (value: string) => void
  onSave: () => void
  onClear: () => void
  onClose: () => void
}

export function SettingsDialog({ open, secretDraft, onDraft, onSave, onClear, onClose }: SettingsDialogProps) {
  return (
    <div className="settings-layer" hidden={!open}>
      <div className="settings-card" role="dialog" aria-labelledby="settings-title">
        <div className="pane-title">
          <h2 id="settings-title">Settings</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="hint">The key is encrypted on this Mac and used only by the main process for BharatCode. Its value never returns to this window.</p>
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
      </div>
    </div>
  )
}
