import { useCallback, useEffect, useRef, useState } from 'react'
import packageJson from '../../../package.json'
import type { AgentEvent, AgentMissionSummary, AgentToolRecord, AgentTranscript } from '../../shared/agent'
import {
  appendStreamDelta,
  appendToolActivity,
  conversationFromTranscript,
  sealConversation,
  type ConversationEntry
} from './conversation'
import { connectionLabel, type ConnectionState, type ProviderId } from '../../shared/provider'
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
  const [providerChoice, setProviderChoice] = useState<ProviderId>('bharatcode')
  const [connection, setConnection] = useState<ConnectionState>('not_configured')
  const [providerDetail, setProviderDetail] = useState('No BharatCode API key is stored.')
  const [tokenNote, setTokenNote] = useState('')
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
  const [agentMission, setAgentMission] = useState<AgentMissionSummary | null>(null)
  const [conversation, setConversation] = useState<ConversationEntry[]>([])
  const [agentTools, setAgentTools] = useState<AgentToolRecord[]>([])
  const [agentNotice, setAgentNotice] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const shownMission = useRef<string | null>(null)
  const pendingPrompt = useRef('')
  const armNextMission = useRef(false)
  const streamStarted = useRef(false)
  const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
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

  const applyProvider = useCallback((status: { provider: ProviderId; state: ConnectionState; detail: string }): void => {
    setProviderChoice(status.provider)
    setConnection(status.state)
    setProviderDetail(status.detail)
  }, [])

  const refreshProvider = useCallback(async (): Promise<void> => {
    const result = await window.kern.provider.get()
    if (result.ok) {
      applyProvider(result.data)
    }
  }, [applyProvider])

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
      await refreshProvider()
    })()
  }, [refreshHistory, refreshProvider, refreshSecret, refreshTree])

  useEffect(() => {
    if (!activePath) {
      setDiagnostics([])
    }
  }, [activePath])

  const applyTranscript = useCallback((transcript: AgentTranscript | null): void => {
    if (!transcript) {
      return
    }
    shownMission.current = transcript.mission.id
    armNextMission.current = false
    streamStarted.current = false
    setAgentMission(transcript.mission)
    setConversation(conversationFromTranscript(transcript))
    setAgentTools(transcript.tools)
    setAgentNotice(transcript.mission.error ?? '')
  }, [])

  useEffect(() => {
    const accepts = (missionId: string): boolean => {
      if (armNextMission.current) {
        armNextMission.current = false
        streamStarted.current = true
        shownMission.current = missionId
        setConversation([{ key: 'user', role: 'user', content: pendingPrompt.current, streaming: false }])
        setAgentTools([])
        setAgentNotice('')
        return true
      }
      return shownMission.current === missionId
    }
    const id = window.kern.agent.onEvent((event: AgentEvent) => {
      if (event.type === 'status') {
        if (accepts(event.missionId)) {
          setConversation((current) => sealConversation(current))
        }
        setAgentMission((current) =>
          current && current.id === event.missionId
            ? { ...current, status: event.status, title: event.title }
            : { id: event.missionId, title: event.title, prompt: current?.prompt ?? event.title, status: event.status, iteration: 0, toolCalls: 0, summary: null, error: null, createdAt: '', updatedAt: '' }
        )
        return
      }
      if (event.type === 'text') {
        if (!accepts(event.missionId)) {
          return
        }
        setConversation((current) => appendStreamDelta(current, event.delta))
        return
      }
      if (event.type === 'tool') {
        if (!accepts(event.missionId)) {
          return
        }
        setConversation((current) =>
          appendToolActivity(current, {
            callId: event.callId,
            name: event.name,
            argumentsText: event.argumentsText,
            state: event.state
          })
        )
        setAgentTools((current) => {
          const next = current.filter((tool) => tool.callId !== event.callId)
          return [...next, { callId: event.callId, name: event.name, argumentsText: event.argumentsText, state: event.state, output: event.output ?? '' }]
        })
        return
      }
      if (event.type === 'error') {
        setAgentNotice(event.message)
        return
      }
      if (event.usage) {
        setTokenNote(`${event.usage.totalTokens} tokens`)
      }
      setAgentMission((current) => (current && current.id === event.missionId ? { ...current, status: event.status, summary: event.summary || current.summary } : current))
      void refreshProvider()
      void window.kern.agent.transcript({ missionId: event.missionId }).then((result) => {
        if (result.ok && shownMission.current === event.missionId) {
          applyTranscript(result.data)
        }
      })
    })
    void window.kern.agent.current().then((result) => {
      if (result.ok) {
        applyTranscript(result.data)
      }
    })
    return () => window.kern.agent.offEvent(id)
  }, [applyTranscript, refreshProvider])

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
    await refreshProvider()
  }

  async function clearSecret(): Promise<void> {
    const result = await window.kern.secrets.clear()
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSecretDraft('')
    await refreshSecret()
    await refreshProvider()
  }

  async function chooseProvider(provider: ProviderId): Promise<void> {
    const result = await window.kern.provider.set({ provider })
    if (!result.ok) {
      setError(result.error)
      return
    }
    applyProvider(result.data)
  }

  async function checkProvider(): Promise<void> {
    const result = await window.kern.provider.check()
    if (!result.ok) {
      setError(result.error)
      return
    }
    applyProvider(result.data)
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

  async function submitMission(prompt: string): Promise<void> {
    pendingPrompt.current = prompt
    armNextMission.current = true
    streamStarted.current = false
    const result = await window.kern.agent.submit({ prompt })
    if (!result.ok) {
      armNextMission.current = false
      setError(result.error)
      setAgentNotice(result.error)
      return
    }
    shownMission.current = result.data.missionId
    armNextMission.current = false
    if (!streamStarted.current) {
      setConversation([{ key: 'user', role: 'user', content: prompt, streaming: false }])
      setAgentTools([])
      setAgentNotice('')
    }
    setAgentMission((current) =>
      current && current.id === result.data.missionId
        ? current
        : {
            id: result.data.missionId,
            title: prompt,
            prompt,
            status: 'queued',
            iteration: 0,
            toolCalls: 0,
            summary: null,
            error: null,
            createdAt: '',
            updatedAt: ''
          }
    )
    setError('')
  }

  async function cancelMission(): Promise<void> {
    if (!agentMission) {
      return
    }
    const result = await window.kern.agent.cancel({ missionId: agentMission.id })
    if (!result.ok) {
      setAgentNotice(result.error)
    }
  }

  async function cancelTerminal(): Promise<void> {
    const result = await window.kern.terminal.cancel()
    if (!result.ok) {
      setError(result.error)
    }
  }

  const agentRunning = Boolean(agentMission && !terminalStatuses.has(agentMission.status))
  const providerName = providerChoice === 'cursor' ? 'Cursor' : 'BharatCode'
  const providerBadge = connectionLabel(connection, agentRunning)
  const providerReady = connection !== 'not_configured'
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
        providerName={providerName}
        providerLabel={providerBadge}
        providerState={agentRunning ? 'running' : connection}
        missionTitle={agentRunning && agentMission ? agentMission.title : 'No active mission'}
        missionLive={agentRunning}
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
        {rightOpen ? (
          <AgentPanel
            changes={changes}
            providerReady={providerReady}
            providerDetail={connection === 'verified' ? '' : providerDetail}
            workspaceOpen={Boolean(workspace)}
            mission={agentMission}
            running={agentRunning}
            messages={conversation}
            tools={agentTools}
            notice={agentNotice}
            onSubmit={(prompt) => void submitMission(prompt)}
            onCancel={() => void cancelMission()}
            onClose={() => setRightOpen(false)}
          />
        ) : null}
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
          <span className="footer-link">
            {providerName} {providerBadge}{tokenNote ? ` · ${tokenNote}` : ''}
          </span>
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
        provider={providerChoice}
        connectionState={connection}
        detail={providerDetail}
        secretDraft={secretDraft}
        onProvider={(provider) => void chooseProvider(provider)}
        onDraft={setSecretDraft}
        onSave={() => void saveSecret()}
        onClear={() => void clearSecret()}
        onCheck={() => void checkProvider()}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}
