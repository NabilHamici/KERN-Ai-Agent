import type { RefObject } from 'react'
import kernLogo from '../assets/kern-logo.svg'
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
  providerName: string
  providerLabel: string
  providerTitle: string
  providerState: string
  missionTitle: string
  missionLive: boolean
  gitLabel: string
  gitTitle: string
  gitDisabled?: boolean
  onGitClick?: () => void
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
  providerName,
  providerLabel,
  providerTitle,
  providerState,
  missionTitle,
  missionLive,
  gitLabel,
  gitTitle,
  gitDisabled = true,
  onGitClick,
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
            <img src={kernLogo} alt="" className="logo-mark" width={24} height={24} />
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
        <div className={missionLive ? 'mission-pill is-live' : 'mission-pill'} title={missionTitle}>
          <Icon name="zap" />
          <span>{missionTitle}</span>
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
        <div
          className="model-badge"
          data-provider={providerState}
          title={providerTitle}
        >
          <Icon name="zap" className="tone-amber" />
          <span>{providerName}</span>
          <span className="badge-off">{providerLabel}</span>
        </div>
        <span data-secret-status className={keyClass}>
          {secretStatus}
        </span>
        <span className="vdiv" />
        <button
          type="button"
          className="branch-chip"
          disabled={gitDisabled}
          title={gitTitle}
          onClick={onGitClick}
        >
          <Icon name="branch" className="tone-violet" />
          {gitLabel}
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
