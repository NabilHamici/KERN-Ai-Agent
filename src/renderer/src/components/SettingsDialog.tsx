import { useEffect, useState } from 'react'
import type { AuthPublicUser } from '../../../shared/auth'
import type { ConnectionState, ProviderId } from '../../../shared/provider'

type DeviceRow = {
  id: string
  deviceName: string
  platform: string
  appVersion: string
  lastSeenAt: string
  createdAt: string
  current: boolean
}

type SettingsDialogProps = {
  open: boolean
  provider: ProviderId
  connectionState: ConnectionState
  detail: string
  secretDraft: string
  authUser: AuthPublicUser
  offlineGrace: boolean
  onProvider: (provider: ProviderId) => void
  onDraft: (value: string) => void
  onSave: () => void
  onClear: () => void
  onCheck: () => void
  onLogout: () => void
  onLogoutAll: () => void
  onClose: () => void
}

export function SettingsDialog({
  open,
  provider,
  connectionState,
  detail,
  secretDraft,
  authUser,
  offlineGrace,
  onProvider,
  onDraft,
  onSave,
  onClear,
  onCheck,
  onLogout,
  onLogoutAll,
  onClose
}: SettingsDialogProps) {
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [accountError, setAccountError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    void window.kern.auth.devices().then((result) => {
      if (cancelled) {
        return
      }
      if (result.ok) {
        setDevices(result.data)
        setAccountError('')
      } else {
        setAccountError(result.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open])

  async function logout(): Promise<void> {
    setBusy(true)
    const result = await window.kern.auth.logout()
    setBusy(false)
    if (!result.ok) {
      setAccountError(result.error)
      return
    }
    onLogout()
  }

  async function logoutAll(): Promise<void> {
    setBusy(true)
    const result = await window.kern.auth.logoutAll()
    setBusy(false)
    if (!result.ok) {
      setAccountError(result.error)
      return
    }
    onLogoutAll()
  }

  const currentDevice = devices.find((device) => device.current)

  return (
    <div className="settings-layer" hidden={!open}>
      <div className="settings-card" role="dialog" aria-labelledby="settings-title">
        <div className="pane-title">
          <h2 id="settings-title">Settings</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <section className="settings-section">
          <h3>Account</h3>
          <p className="hint">
            Signed in as <strong>{authUser.displayName}</strong>
          </p>
          <p className="hint">
            {authUser.email}
            {authUser.emailVerified ? ' · verified' : ''}
          </p>
          {offlineGrace ? (
            <p className="hint warn-hint">
              Working offline with a cached session. Reconnect before the grace period expires.
            </p>
          ) : null}
          <p className="hint">
            Current device: {currentDevice ? `${currentDevice.deviceName} (${currentDevice.platform})` : 'This installation'}
          </p>
          {accountError ? <p className="hint warn-hint">{accountError}</p> : null}
          <div className="settings-actions">
            <button type="button" className="text-button" disabled={busy} onClick={() => void logout()}>
              Log out
            </button>
            <button type="button" className="text-button" disabled={busy} onClick={() => void logoutAll()}>
              Log out all devices
            </button>
          </div>
        </section>

        <label className="secret-field">
          Model provider
          <select value={provider} data-provider-select onChange={(event) => onProvider(event.target.value as ProviderId)}>
            <option value="bharatcode">BharatCode · qwen-3.8-27b (default)</option>
            <option value="cursor">dev provider · composer-2.5</option>
          </select>
        </label>
        <p className="hint" data-provider-connection data-connection-state={connectionState}>
          {detail}
        </p>
        <p className="hint">
          BharatCode is the product default and uses a saved API key. The optional “dev provider” is for local development only and is not the product default. Check connection does not start a mission.
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
