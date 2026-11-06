import { useCallback, useEffect, useRef, useState } from 'react'
import packageJson from '../../../package.json'
import { AgentPanel } from './components/AgentPanel'
import { BottomPanel } from './components/BottomPanel'
import { EditorArea } from './components/EditorArea'
import { Explorer } from './components/Explorer'
import { SettingsDialog } from './components/SettingsDialog'
import { TopBar } from './components/TopBar'
import type { EditorDiagnostic } from './EditorPane'
import { hasExternalChange, isDirty, isSessionRecord, secretLabel, type SessionRecord } from './editorState'
import type { DirectoryEntry } from '../../shared/ipc'

type WorkspaceInfo = { path: string; name: string }
type FileChange = { relativePath: string; changeType: string; createdAt: string; hasReverse: boolean }
type BufferState = { baseline: string; value: string }

export function App() {
  const buffers = useRef(new Map<string, BufferState>())
  const reader = useRef<() => string>(() => '')
  const expandedRef = useRef<Record<string, DirectoryEntry[]>>({})
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [expanded, setExpanded] = useState<Record<string, DirectoryEntry[]>>({})
  const [tabs, setTabs] = useState<string[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [loadedValue, setLoadedValue] = useState('')
  const [revision, setRevision] = useState(0)
  const [conflict, setConflict] = useState<{ path: string; disk: string } | null>(null)
  const [changes, setChanges] = useState<FileChange[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [secretConfigured, setSecretConfigured] = useState(false)
  const [secretAvailable, setSecretAvailable] = useState(true)
  const [secretDraft, setSecretDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const [treeLoading, setTreeLoading] = useState(false)
  const [opening, setOpening] = useState(false)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [diagnostics, setDiagnostics] = useState<EditorDiagnostic[]>([])
  const [query, setQuery] = useState('')
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [bottomOpen, setBottomOpen] = useState(true)
  const searchRef = useRef<HTMLInputElement>(null)
  expandedRef.current = expanded

  const bump = (): void => {
    setRevision((value) => value + 1)
  }

  const resetEditor = (): void => {
    buffers.current.clear()
    setTabs([])
    setActivePath(null)
    setLoadedValue('')
    setConflict(null)
    setDiagnostics([])
  }

  const listDirectory = useCallback(async (path: string): Promise<DirectoryEntry[]> => {
    const result = await window.kern.workspace.list({ path })
    if (!result.ok) {
      throw new Error(result.error)
    }
    return result.data
  }, [])

  const refreshTree = useCallback(async (): Promise<void> => {
    setTreeLoading(true)
    try {
      const listed = await window.kern.workspace.list({ path: '.' })
      if (!listed.ok) {
        setError(listed.error)
        return
      }
      setEntries(listed.data)
      const next: Record<string, DirectoryEntry[]> = {}
      for (const path of Object.keys(expandedRef.current)) {
        const children = await window.kern.workspace.list({ path })
        if (children.ok) {
          next[path] = children.data
        }
      }
      setExpanded(next)
    } finally {
      setTreeLoading(false)
    }
  }, [])

  const refreshHistory = useCallback(async (): Promise<void> => {
    const [fileResult, missionResult] = await Promise.all([
      window.kern.history.fileChanges({ limit: 20 }),
      window.kern.history.missions({ limit: 12 })
    ])
    if (fileResult.ok) {
      setChanges(fileResult.data)
    }
    if (missionResult.ok) {
      setSessions(missionResult.data.filter(isSessionRecord))
    }
  }, [])

  const refreshSecret = useCallback(async (): Promise<void> => {
    const result = await window.kern.secrets.status()
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSecretConfigured(result.data.configured)
    setSecretAvailable(result.data.storageAvailable)
  }, [])

  useEffect(() => {
    void (async () => {
      const current = await window.kern.workspace.current()
      if (!current.ok) {
        setError(current.error)
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

  useEffect(() => {
    if (!activePath) {
      setDiagnostics([])
    }
  }, [activePath])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setLeftOpen(true)
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function openFolder(): Promise<void> {
    const selected = await window.kern.workspace.select()
    if (!selected.ok) {
      setError(selected.error)
      return
    }
    if (selected.data.canceled) {
      return
    }
    resetEditor()
    setExpanded({})
    setWorkspace(selected.data.workspace)
    setError('')
    await refreshTree()
    await refreshHistory()
  }

  function activate(path: string): void {
    const buffer = buffers.current.get(path)
    if (!buffer || path === activePath) {
      return
    }
    setActivePath(path)
    setLoadedValue(buffer.value)
    setConflict((current) => (current?.path === path ? current : null))
  }

  async function openEntry(entry: DirectoryEntry): Promise<void> {
    if (entry.blocked) {
      setError('Path escapes the workspace')
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
      try {
        const children = await listDirectory(entry.relativePath)
        setExpanded((current) => ({ ...current, [entry.relativePath]: children }))
        setError('')
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to open folder')
      }
      return
    }
    const existing = buffers.current.get(entry.relativePath)
    if (existing) {
      setTabs((current) => (current.includes(entry.relativePath) ? current : [...current, entry.relativePath]))
      activate(entry.relativePath)
      return
    }
    setOpening(true)
    const result = await window.kern.workspace.read({ path: entry.relativePath })
    setOpening(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    buffers.current.set(entry.relativePath, { baseline: result.data.content, value: result.data.content })
    setTabs((current) => [...current, entry.relativePath])
    setActivePath(entry.relativePath)
    setLoadedValue(result.data.content)
    setConflict(null)
    setError('')
  }

  function closeTab(path: string): void {
    const buffer = buffers.current.get(path)
    if (buffer && isDirty(buffer.baseline, buffer.value) && !window.confirm(`Close ${path} without saving?`)) {
      return
    }
    buffers.current.delete(path)
    const remaining = tabs.filter((tab) => tab !== path)
    setTabs(remaining)
    if (activePath !== path) {
      return
    }
    const next = remaining[remaining.length - 1] ?? null
    setActivePath(next)
    setLoadedValue(next ? (buffers.current.get(next)?.value ?? '') : '')
    setConflict(null)
  }

  async function save(force: boolean): Promise<void> {
    if (!activePath) {
      return
    }
    const buffer = buffers.current.get(activePath)
    if (!buffer) {
      return
    }
    const content = reader.current()
    buffer.value = content
    const disk = await window.kern.workspace.read({ path: activePath })
    if (!disk.ok) {
      setError(disk.error)
      return
    }
    if (!force && hasExternalChange(buffer.baseline, disk.data.content)) {
      setConflict({ path: activePath, disk: disk.data.content })
      setError('Save blocked because the file changed on disk.')
      bump()
      return
    }
    const written = await window.kern.workspace.write({ path: activePath, content })
    if (!written.ok) {
      setError(written.error)
      return
    }
    buffer.baseline = content
    buffer.value = content
    setConflict(null)
    setError('')
    bump()
    await refreshHistory()
  }

  function reloadFromDisk(): void {
    if (!conflict || conflict.path !== activePath) {
      return
    }
    const buffer = buffers.current.get(conflict.path)
    if (!buffer) {
      return
    }
    buffer.baseline = conflict.disk
    buffer.value = conflict.disk
    setLoadedValue(conflict.disk)
    setConflict(null)
    setError('')
    bump()
  }

  async function removeOpenFile(): Promise<void> {
    if (!activePath) {
      return
    }
    if (!window.confirm(`Delete ${activePath}?`)) {
      return
    }
    const result = await window.kern.workspace.remove({ path: activePath, confirm: true })
    if (!result.ok) {
      setError(result.error)
      return
    }
    buffers.current.delete(activePath)
    const remaining = tabs.filter((tab) => tab !== activePath)
    const next = remaining[remaining.length - 1] ?? null
    setTabs(remaining)
    setActivePath(next)
    setLoadedValue(next ? (buffers.current.get(next)?.value ?? '') : '')
    setError('')
    await refreshTree()
    await refreshHistory()
  }

  async function saveSecret(): Promise<void> {
    const result = await window.kern.secrets.set({ apiKey: secretDraft })
    setSecretDraft('')
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError('')
    await refreshSecret()
  }

  async function clearSecret(): Promise<void> {
    const result = await window.kern.secrets.clear()
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSecretDraft('')
    await refreshSecret()
  }

  async function createFile(): Promise<void> {
    if (!workspace) {
      return
    }
    const relative = window.prompt('File path inside the workspace')
    if (!relative?.trim()) {
      return
    }
    const result = await window.kern.workspace.createFile({ path: relative.trim(), content: '' })
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError('')
    await refreshTree()
    await refreshHistory()
  }

  async function cancelTerminal(): Promise<void> {
    const result = await window.kern.terminal.cancel()
    if (!result.ok) {
      setError(result.error)
    }
  }

  const errorCount = diagnostics.filter((item) => item.severity === 'error').length
  const warningCount = diagnostics.filter((item) => item.severity === 'warning').length

  return (
    <div className="app">
      <TopBar
        projectName={workspace?.name ?? 'Open folder'}
        workspacePath={workspace?.path ?? ''}
        version={packageJson.version}
        query={query}
        searchRef={searchRef}
        secretStatus={secretLabel(secretAvailable, secretConfigured)}
        secretAvailable={secretAvailable}
        secretConfigured={secretConfigured}
        onQuery={(value) => {
          setQuery(value)
          if (value.trim()) {
            setLeftOpen(true)
          }
        }}
        onOpenFolder={() => void openFolder()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="work">
      {error ? (
        <p className="banner" role="alert">
          {error}
        </p>
      ) : null}
      <div className="shell">
        {leftOpen ? (
          <Explorer
            projectName={workspace?.name ?? 'No folder'}
            entries={entries}
            expanded={expanded}
            activePath={activePath}
            loading={treeLoading}
            query={query}
            refreshDisabled={!workspace}
            canCreate={Boolean(workspace)}
            onOpen={(entry) => void openEntry(entry)}
            onRefresh={() => void refreshTree()}
            onCreateFile={() => void createFile()}
            onClose={() => setLeftOpen(false)}
            listDirectory={listDirectory}
          />
        ) : null}
        <div className="center">
          <EditorArea
            tabs={tabs}
            activePath={activePath}
            loadedValue={loadedValue}
            buffers={buffers.current}
            revision={revision}
            opening={opening}
            conflict={conflict}
            explorerHidden={!leftOpen}
            onShowExplorer={() => setLeftOpen(true)}
            onActivate={activate}
            onClose={closeTab}
            onSave={() => void save(false)}
            onOverwrite={() => void save(true)}
            onReload={reloadFromDisk}
            onDelete={() => void removeOpenFile()}
            onReady={(getValue) => {
              reader.current = getValue
            }}
            onChange={(path, value) => {
              const buffer = buffers.current.get(path)
              if (!buffer || buffer.value === value) {
                return
              }
              buffer.value = value
              bump()
            }}
            onCursor={setCursor}
            onDiagnostics={setDiagnostics}
          />
          <BottomPanel
            workspacePath={workspace?.path ?? null}
            diagnostics={diagnostics}
            open={bottomOpen}
            onClose={() => setBottomOpen(false)}
            onCancel={() => void cancelTerminal()}
          />
        </div>
        {rightOpen ? <AgentPanel changes={changes} sessions={sessions} onClose={() => setRightOpen(false)} /> : null}
      </div>
      </div>
      <footer className="statusbar">
        <div className="status-group">
          <span>
            <span className="ready-dot" /> {workspace ? 'KERN Ready' : 'No workspace'}
          </span>
          <span>UTF-8</span>
          <span>Spaces: 2</span>
          {!bottomOpen ? (
            <button type="button" className="footer-link" onClick={() => setBottomOpen(true)}>
              Show terminal
            </button>
          ) : null}
          {!rightOpen ? (
            <button type="button" className="footer-link" onClick={() => setRightOpen(true)}>
              Show agent
            </button>
          ) : null}
        </div>
        <div className="status-group">
          <span className="footer-link">Provider disconnected</span>
          <span>
            Ln {cursor.line}, Col {cursor.column}
          </span>
          <span>
            {errorCount} Error{errorCount === 1 ? '' : 's'}, {warningCount} Warning{warningCount === 1 ? '' : 's'}
          </span>
        </div>
      </footer>
      <SettingsDialog
        open={settingsOpen}
        secretDraft={secretDraft}
        onDraft={setSecretDraft}
        onSave={() => void saveSecret()}
        onClear={() => void clearSecret()}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}
