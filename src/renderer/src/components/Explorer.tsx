import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MetricsSample } from '../../../shared/metrics'
import { collectFiles } from '../editorState'
import { fileTone, Icon } from './Icons'
import type { DirectoryEntry } from '../../../shared/ipc'

type GitEntry = { path: string; status: string }

type ExplorerProps = {
  projectName: string
  entries: DirectoryEntry[]
  expanded: Record<string, DirectoryEntry[]>
  activePath: string | null
  loading: boolean
  query: string
  refreshDisabled: boolean
  canCreate: boolean
  metrics: MetricsSample | null
  metricsReason?: string
  gitEntries: GitEntry[]
  gitError?: string | null
  highlightedPaths?: Set<string>
  scanning?: boolean
  gitStatusByPath?: Record<string, string>
  onOpenGitFile: (path: string) => void
  onPublish?: () => void
  onOpen: (entry: DirectoryEntry) => void
  onRefresh: () => void
  onCreateFile: () => void
  onClose: () => void
  listDirectory: (path: string) => Promise<DirectoryEntry[]>
}

function formatRam(bytes: number | null): string {
  if (bytes === null) {
    return '—'
  }
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

function formatCpu(pct: number | null): string {
  if (pct === null) {
    return '—'
  }
  return `${Math.round(pct)}%`
}

function formatTps(sample: MetricsSample | null): string {
  if (!sample) {
    return '—'
  }
  const tps = sample.tokens.tps
  if (tps === null) {
    return '—'
  }
  const prefix = sample.tokens.estimated ? '~' : ''
  return `${prefix}${tps.toFixed(1)}/s`
}

function metricsTooltip(sample: MetricsSample | null): string {
  if (!sample) {
    return ''
  }
  const lines = [
    `System CPU ${formatCpu(sample.system.cpuPct)}`,
    `RAM ${formatRam(sample.system.usedBytes)} / ${formatRam(sample.system.totalBytes)}`
  ]
  for (const group of sample.groups) {
    lines.push(`${group.name}: CPU ${formatCpu(group.cpuPct)}, RAM ${formatRam(group.ramBytes)}`)
  }
  if (sample.tokens.inTotal !== null || sample.tokens.outTotal !== null) {
    lines.push(`Tokens in ${sample.tokens.inTotal ?? '—'} · out ${sample.tokens.outTotal ?? '—'}`)
  }
  if (sample.unavailableReason) {
    lines.push(sample.unavailableReason)
  }
  return lines.join('\n')
}

function metersUnavailable(sample: MetricsSample | null, metricsReason?: string): boolean {
  if (!sample) {
    return Boolean(metricsReason)
  }
  return Boolean(sample.unavailableReason) && sample.cpuPct === null && sample.ramBytes === null
}

export function Explorer({
  projectName,
  entries,
  expanded,
  activePath,
  loading,
  query,
  refreshDisabled,
  canCreate,
  metrics,
  metricsReason,
  gitEntries,
  gitError,
  highlightedPaths,
  scanning,
  gitStatusByPath,
  onOpenGitFile,
  onPublish,
  onOpen,
  onRefresh,
  onCreateFile,
  onClose,
  listDirectory
}: ExplorerProps) {
  const [results, setResults] = useState<DirectoryEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(media.matches)
    const listener = (): void => setReducedMotion(media.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])

  useEffect(() => {
    const needle = query.trim()
    if (!needle) {
      setResults(null)
      setSearching(false)
      setSearchError('')
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      void collectFiles(listDirectory, needle)
        .then((found) => {
          if (!cancelled) {
            setResults(found)
            setSearchError('')
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setResults([])
            setSearchError(error instanceof Error ? error.message : 'Search failed')
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearching(false)
          }
        })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [listDirectory, query])

  const cpuWidth = useMemo(() => {
    if (metrics?.cpuPct === null || metrics?.cpuPct === undefined) {
      return 0
    }
    return Math.max(0, Math.min(100, metrics.cpuPct))
  }, [metrics])

  const ramWidth = useMemo(() => {
    if (!metrics || metrics.ramBytes === null || metrics.system.totalBytes === null || metrics.system.totalBytes <= 0) {
      return 0
    }
    return Math.max(0, Math.min(100, (metrics.ramBytes / metrics.system.totalBytes) * 100))
  }, [metrics])

  const metersOff = metersUnavailable(metrics, metricsReason)
  const meterTitle = metricsTooltip(metrics) || metricsReason || 'Process metrics'

  function fileRowClass(path: string): string {
    const highlight = highlightedPaths?.has(path)
    if (!highlight) {
      return 'file-row'
    }
    return reducedMotion ? 'file-row is-new' : 'file-row is-new is-animated'
  }

  function renderEntries(rows: DirectoryEntry[], depth: number): ReactNode {
    return rows.map((entry) => {
      const isDirectory = entry.kind === 'directory'
      const isOpen = isDirectory && expanded[entry.relativePath] !== undefined
      const gitStatus = gitStatusByPath?.[entry.relativePath]
      return (
        <div key={entry.relativePath}>
          <button
            type="button"
            className={fileRowClass(entry.relativePath)}
            style={{ paddingLeft: 8 + depth * 14 }}
            data-path={entry.relativePath}
            data-kind={entry.kind}
            data-blocked={entry.blocked ? 'true' : 'false'}
            data-active={entry.relativePath === activePath ? 'true' : 'false'}
            data-git-status={gitStatus ?? undefined}
            onClick={() => onOpen(entry)}
          >
            {isDirectory ? <Icon name={isOpen ? 'chevron-down' : 'chevron'} /> : <span className="chevron-spacer" />}
            <Icon
              name={isDirectory ? (isOpen ? 'folder-open' : 'folder') : 'file'}
              className={isDirectory ? (depth === 0 ? 'tone-violet' : 'tone-indigo') : fileTone(entry.name)}
            />
            <span className="file-name">{entry.name}</span>
            {gitStatus ? <span className={`git-status-pill git-status-${gitStatus}`}>{gitStatus}</span> : null}
            {entry.blocked ? <span className="blocked-label">blocked</span> : null}
          </button>
          {isOpen ? renderEntries(expanded[entry.relativePath] ?? [], depth + 1) : null}
        </div>
      )
    })
  }

  return (
    <aside className="explorer">
      <div className="pane-head">
        <span>EXPLORER</span>
        <div className="pane-actions">
          <button
            type="button"
            className="icon-hit"
            title="Create a file inside the workspace"
            onClick={onCreateFile}
            disabled={!canCreate}
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="icon-hit"
            data-action="refresh"
            title="Refresh files"
            onClick={onRefresh}
            disabled={refreshDisabled}
          >
            <Icon name="refresh" />
          </button>
          <button type="button" className="icon-hit" title="Hide explorer" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </div>
      <div className="project-label">
        <span>{projectName}</span>
        {scanning ? <span className="scanning-hint">scanning…</span> : null}
      </div>
      <div className="tree">
        {loading && entries.length === 0 ? <p className="muted">Loading workspace…</p> : null}
        {!loading && entries.length === 0 ? <p className="muted">Open a folder to browse files.</p> : null}
        {results === null ? renderEntries(entries, 0) : null}
        {results !== null ? (
          <div className="search-results">
            <p className="muted">{searching ? 'Searching…' : `${results.length} match${results.length === 1 ? '' : 'es'}`}</p>
            <p className="hint">Search skips node_modules and .git.</p>
            {searchError ? <p className="error">{searchError}</p> : null}
            {results.map((entry) => (
              <button
                key={entry.relativePath}
                type="button"
                className={fileRowClass(entry.relativePath)}
                data-path={entry.relativePath}
                data-kind={entry.kind}
                data-blocked="false"
                data-active={entry.relativePath === activePath ? 'true' : 'false'}
                onClick={() => onOpen(entry)}
              >
                <Icon
                  name={entry.kind === 'directory' ? 'folder' : 'file'}
                  className={entry.kind === 'directory' ? 'tone-indigo' : fileTone(entry.name)}
                />
                <span className="file-name">{entry.relativePath}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="git-block">
          <div className="git-label">
            <span>GIT CHANGES</span>
            <div className="git-label-actions">
              {onPublish ? (
                <button type="button" className="text-button git-publish-link" onClick={onPublish}>
                  Publish…
                </button>
              ) : null}
              <Icon name="branch" className="tone-violet" />
            </div>
          </div>
          {gitError ? <p className="git-empty">{gitError}</p> : null}
          {!gitError && gitEntries.length === 0 ? <p className="git-empty">No changes</p> : null}
          {gitEntries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="file-row git-change-row"
              data-git-status={entry.status}
              onClick={() => onOpenGitFile(entry.path)}
            >
              <span className={`git-status-pill git-status-${entry.status}`}>{entry.status}</span>
              <span className="file-name">{entry.path}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="meters" title={meterTitle}>
        <div>
          <div className="meter-label">
            <span>
              <Icon name="cpu" className="tone-violet" /> CPU
            </span>
            <span>{metersOff ? 'Unavailable' : formatCpu(metrics?.cpuPct ?? null)}</span>
          </div>
          <div className="track">
            <i className="meter-fill" style={{ width: metersOff ? 0 : `${cpuWidth}%` }} />
          </div>
        </div>
        <div>
          <div className="meter-label">
            <span>
              <Icon name="disk" className="tone-blue" /> RAM
            </span>
            <span>{metersOff ? 'Unavailable' : formatRam(metrics?.ramBytes ?? null)}</span>
          </div>
          <div className="track">
            <i className="meter-fill ram" style={{ width: metersOff ? 0 : `${ramWidth}%` }} />
          </div>
        </div>
        <div className="meter-label">
          <span>
            <Icon name="zap" className="tone-emerald" /> TOKEN RATE
          </span>
          <span>{metersOff ? 'Unavailable' : formatTps(metrics)}</span>
        </div>
      </div>
    </aside>
  )
}
