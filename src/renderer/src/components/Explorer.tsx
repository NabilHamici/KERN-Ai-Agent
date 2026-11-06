import { useEffect, useState, type ReactNode } from 'react'
import { collectFiles } from '../editorState'
import { fileTone, Icon } from './Icons'
import type { DirectoryEntry } from '../../../shared/ipc'

type ExplorerProps = {
  projectName: string
  entries: DirectoryEntry[]
  expanded: Record<string, DirectoryEntry[]>
  activePath: string | null
  loading: boolean
  query: string
  refreshDisabled: boolean
  canCreate: boolean
  onOpen: (entry: DirectoryEntry) => void
  onRefresh: () => void
  onCreateFile: () => void
  onClose: () => void
  listDirectory: (path: string) => Promise<DirectoryEntry[]>
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
  onOpen,
  onRefresh,
  onCreateFile,
  onClose,
  listDirectory
}: ExplorerProps) {
  const [results, setResults] = useState<DirectoryEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')

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

  function renderEntries(rows: DirectoryEntry[], depth: number): ReactNode {
    return rows.map((entry) => {
      const isDirectory = entry.kind === 'directory'
      const isOpen = isDirectory && expanded[entry.relativePath] !== undefined
      return (
        <div key={entry.relativePath}>
          <button
            type="button"
            className="file-row"
            style={{ paddingLeft: 8 + depth * 14 }}
            data-path={entry.relativePath}
            data-kind={entry.kind}
            data-blocked={entry.blocked ? 'true' : 'false'}
            data-active={entry.relativePath === activePath ? 'true' : 'false'}
            onClick={() => onOpen(entry)}
          >
            {isDirectory ? <Icon name={isOpen ? 'chevron-down' : 'chevron'} /> : <span className="chevron-spacer" />}
            <Icon
              name={isDirectory ? (isOpen ? 'folder-open' : 'folder') : 'file'}
              className={isDirectory ? (depth === 0 ? 'tone-violet' : 'tone-indigo') : fileTone(entry.name)}
            />
            <span className="file-name">{entry.name}</span>
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
      </div>
      <div className="tree">
        {loading ? <p className="muted">Loading workspace…</p> : null}
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
                className="file-row"
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
            <Icon name="branch" className="tone-violet" />
          </div>
          <p className="git-empty" title="Git status needs a workspace-scoped reader. That channel does not exist yet.">
            Unavailable
          </p>
        </div>
      </div>
      <div className="meters" title="Process and token meters are not collected.">
        <div>
          <div className="meter-label">
            <span>
              <Icon name="cpu" className="tone-violet" /> CPU
            </span>
            <span>Unavailable</span>
          </div>
          <div className="track">
            <i />
          </div>
        </div>
        <div>
          <div className="meter-label">
            <span>
              <Icon name="disk" className="tone-blue" /> RAM
            </span>
            <span>Unavailable</span>
          </div>
          <div className="track">
            <i />
          </div>
        </div>
        <div className="meter-label">
          <span>
            <Icon name="zap" className="tone-emerald" /> TOKEN RATE
          </span>
          <span>Unavailable</span>
        </div>
      </div>
    </aside>
  )
}
