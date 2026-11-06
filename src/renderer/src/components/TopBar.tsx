import type { RefObject } from 'react'
import { Icon } from './Icons'

type TopBarProps = {
  projectName: string
  workspacePath: string
  version: string
  query: string
  searchRef: RefObject<HTMLInputElement | null>
  secretStatus: string
  secretAvailable: boolean
  secretConfigured: boolean
  onQuery: (value: string) => void
  onOpenFolder: () => void
  onOpenSettings: () => void
}

export function TopBar({
  projectName,
  workspacePath,
  version,
  query,
  searchRef,
  secretStatus,
  secretAvailable,
  secretConfigured,
  onQuery,
  onOpenFolder,
  onOpenSettings
}: TopBarProps) {
  const shortcut = navigator.userAgent.includes('Mac') ? '⌘K' : 'Ctrl+K'
  const keyClass = !secretAvailable ? 'key-pill warn' : secretConfigured ? 'key-pill ok' : 'key-pill'

  return (
    <header className="topbar">
      <div className="cluster">
        <div className="brand-lockup">
          <span className="logo">
            <Icon name="mark" />
          </span>
          <span className="wordmark">KERN</span>
        </div>
        <span className="vdiv" />
        <button
          type="button"
          className="workspace-button"
          data-action="open"
          data-workspace-path={workspacePath}
          title={workspacePath || 'Choose a local project folder'}
          onClick={onOpenFolder}
        >
          <span className={workspacePath ? 'presence on' : 'presence'} />
          <span className="workspace-name">{projectName}</span>
          <span className="version-chip">{version}</span>
          <Icon name="chevron-down" />
        </button>
        <span className="vdiv" />
        <div className="mission-pill" title="No mission is running. The agent runtime is not connected.">
          <Icon name="zap" />
          <span>No active mission</span>
        </div>
      </div>

      <div className="search-wrap">
        <label className="search-shell">
          <span className="search-icon">
            <Icon name="search" />
          </span>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Filter files by name"
            spellCheck={false}
            disabled={!workspacePath}
          />
          <span className="kbd">{shortcut}</span>
        </label>
      </div>

      <div className="cluster">
        <div className="model-badge" data-provider="disconnected" title="No model provider is connected.">
          <Icon name="zap" className="tone-amber" />
          <span>Provider</span>
          <span className="badge-off">Disconnected</span>
        </div>
        <span data-secret-status className={keyClass}>
          {secretStatus}
        </span>
        <span className="vdiv" />
        <button
          type="button"
          className="branch-chip"
          disabled
          title="Git status needs a workspace-scoped Git reader in the main process. That channel does not exist yet."
        >
          <Icon name="branch" className="tone-violet" />
          Git unavailable
        </button>
        <button type="button" className="icon-hit" data-action="settings" onClick={onOpenSettings} title="Settings">
          <Icon name="settings" />
        </button>
        <button type="button" className="avatar" onClick={onOpenSettings} title="Settings">
          K
        </button>
      </div>
    </header>
  )
}
