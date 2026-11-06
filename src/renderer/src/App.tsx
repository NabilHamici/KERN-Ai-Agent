import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { EditorPane } from './EditorPane'
import { TerminalPane } from './TerminalPane'
import type { DirectoryEntry } from '../../shared/ipc'

type WorkspaceInfo = { path: string; name: string }
type FileChange = { relativePath: string; changeType: string; createdAt: string }

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [expanded, setExpanded] = useState<Record<string, DirectoryEntry[]>>({})
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [initialValue, setInitialValue] = useState('')
  const [changes, setChanges] = useState<FileChange[]>([])
  const [secretConfigured, setSecretConfigured] = useState(false)
  const [secretAvailable, setSecretAvailable] = useState(true)
  const [secretDraft, setSecretDraft] = useState('')
  const [error, setError] = useState('')
  const readEditor = useCallback(() => initialValue, [initialValue])
  const editorReader = useState<{ current: () => string }>({ current: readEditor })[0]

  const fail = (message: string): void => {
    setError(message)
  }

  const refreshTree = useCallback(async (): Promise<void> => {
    const listed = await window.kern.workspace.list({ path: '.' })
    if (!listed.ok) {
      fail(listed.error)
      return
    }
    setEntries(listed.data)
    setExpanded({})
  }, [])

  const refreshHistory = useCallback(async (): Promise<void> => {
    const result = await window.kern.history.fileChanges({ limit: 20 })
    if (result.ok) {
      setChanges(result.data)
    }
  }, [])

  const refreshSecret = useCallback(async (): Promise<void> => {
    const result = await window.kern.secrets.status()
    if (!result.ok) {
      fail(result.error)
      return
    }
    setSecretConfigured(result.data.configured)
    setSecretAvailable(result.data.storageAvailable)
  }, [])

  useEffect(() => {
    void (async () => {
      const current = await window.kern.workspace.current()
      if (!current.ok) {
        fail(current.error)
        return
      }
      setWorkspace(current.data)
      if (current.data) {
        await refreshTree()
        await refreshHistory()
      }
      await refreshSecret()
    })()
  }, [refreshHistory, refreshSecret, refreshTree])

  async function openFolder(): Promise<void> {
    const selected = await window.kern.workspace.select()
    if (!selected.ok) {
      fail(selected.error)
      return
    }
    if (selected.data.canceled) {
      return
    }
    setWorkspace(selected.data.workspace)
    setOpenPath(null)
    setError('')
    await refreshTree()
    await refreshHistory()
  }

  async function openFile(entry: DirectoryEntry): Promise<void> {
    if (entry.blocked) {
      fail('Path escapes the workspace')
      return
    }
    if (entry.kind === 'directory') {
      if (expanded[entry.relativePath]) {
        setExpanded((current) => {
          const next = { ...current }
          delete next[entry.relativePath]
          return next
        })
        return
      }
      const listed = await window.kern.workspace.list({ path: entry.relativePath })
      if (!listed.ok) {
        fail(listed.error)
        return
      }
      setExpanded((current) => ({ ...current, [entry.relativePath]: listed.data }))
      return
    }
    const result = await window.kern.workspace.read({ path: entry.relativePath })
    if (!result.ok) {
      fail(result.error)
      return
    }
    setError('')
    setOpenPath(entry.relativePath)
    setInitialValue(result.data.content)
  }

  async function save(): Promise<void> {
    if (!openPath) {
      return
    }
    const content = editorReader.current()
    const result = await window.kern.workspace.write({ path: openPath, content })
    if (!result.ok) {
      fail(result.error)
      return
    }
    setInitialValue(content)
    setError('')
    await refreshHistory()
  }

  async function removeOpenFile(): Promise<void> {
    if (!openPath) {
      return
    }
    if (!window.confirm(`Delete ${openPath}?`)) {
      return
    }
    const result = await window.kern.workspace.remove({ path: openPath, confirm: true })
    if (!result.ok) {
      fail(result.error)
      return
    }
    setOpenPath(null)
    setInitialValue('')
    await refreshTree()
    await refreshHistory()
  }

  async function saveSecret(): Promise<void> {
    const result = await window.kern.secrets.set({ apiKey: secretDraft })
    setSecretDraft('')
    if (!result.ok) {
      fail(result.error)
      return
    }
    setError('')
    await refreshSecret()
  }

  async function clearSecret(): Promise<void> {
    const result = await window.kern.secrets.clear()
    if (!result.ok) {
      fail(result.error)
      return
    }
    setSecretDraft('')
    await refreshSecret()
  }

  function renderEntries(rows: DirectoryEntry[], depth: number): ReactNode {
    return rows.map((entry) => (
      <div key={entry.relativePath}>
        <button
          type="button"
          className="file-row"
          style={{ paddingLeft: 12 + depth * 14 }}
          data-path={entry.relativePath}
          data-kind={entry.kind}
          data-blocked={entry.blocked ? 'true' : 'false'}
          data-active={entry.relativePath === openPath ? 'true' : 'false'}
          onClick={() => void openFile(entry)}
        >
          {entry.kind === 'directory' ? '▸ ' : ''}
          {entry.name}
          {entry.blocked ? ' blocked' : ''}
        </button>
        {expanded[entry.relativePath] ? renderEntries(expanded[entry.relativePath], depth + 1) : null}
      </div>
    ))
  }

  async function cancelTerminal(): Promise<void> {
    const result = await window.kern.terminal.cancel()
    if (!result.ok) {
      fail(result.error)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="mark">KERN</span>
        <span className="workspace-path" data-workspace-path={workspace?.path ?? ''}>
          {workspace ? workspace.path : 'No folder open'}
        </span>
        <span className="spacer" />
        <button type="button" data-action="refresh" onClick={() => void refreshTree()} disabled={!workspace}>
          Refresh
        </button>
        <button type="button" data-action="open" onClick={() => void openFolder()}>
          Open folder
        </button>
      </header>
      <div className="workspace">
        <aside className="files">
          <h2 className="section-title">Files</h2>
          {renderEntries(entries, 0)}
        </aside>
        <main className="editor">
          {openPath ? (
            <>
              <div className="editor-bar">
                <span>{openPath}</span>
                <span className="spacer" />
                <button type="button" data-action="save" onClick={() => void save()}>
                  Save
                </button>
                <button type="button" data-action="delete" onClick={() => void removeOpenFile()}>
                  Delete
                </button>
              </div>
              <EditorPane
                path={openPath}
                initialValue={initialValue}
                onReady={(getValue) => {
                  editorReader.current = getValue
                }}
              />
            </>
          ) : (
            <div className="empty">
              <div>
                <p>Open a project folder, then choose a file.</p>
                <p>KERN keeps filesystem and shell access in the main process.</p>
              </div>
            </div>
          )}
        </main>
        <aside className="activity">
          <h2 className="section-title">Secure storage</h2>
          <div className="secret-box">
            <div data-secret-status className={secretConfigured ? 'ok' : ''}>
              {!secretAvailable ? 'Secure storage unavailable' : secretConfigured ? 'Key stored' : 'No key'}
            </div>
            <input
              data-secret-input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secretDraft}
              placeholder="BharatCode API key"
              onChange={(event) => setSecretDraft(event.target.value)}
            />
            <div className="row">
              <button type="button" data-action="secret-save" onClick={() => void saveSecret()} disabled={!secretDraft}>
                Save key
              </button>
              <button type="button" data-action="secret-clear" onClick={() => void clearSecret()}>
                Clear
              </button>
            </div>
          </div>
          <h2 className="section-title">File changes</h2>
          <div className="activity-block">
            {changes.length === 0 ? <div className="workspace-path">No saved changes yet</div> : null}
            {changes.map((change) => (
              <div key={`${change.createdAt}-${change.relativePath}`} className="change-row" data-file-change={change.relativePath}>
                <span>{change.changeType}</span>
                {change.relativePath}
              </div>
            ))}
          </div>
          {error ? <p className="error">{error}</p> : null}
        </aside>
      </div>
      <TerminalPane workspacePath={workspace?.path ?? null} onCancel={() => void cancelTerminal()} />
    </div>
  )
}
