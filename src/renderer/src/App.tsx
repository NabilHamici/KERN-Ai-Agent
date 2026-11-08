import { useCallback, useEffect, useRef, useState } from 'react'
import packageJson from '../../../package.json'
import type { AuthPublicUser } from '../../shared/auth'
import type {
  AgentChatSummary,
  AgentChatTranscript,
  AgentEvent,
  AgentMissionSummary,
  AgentOperationSummary,
  AgentToolRecord,
  AgentTranscript
} from '../../shared/agent'
import {
  appendStreamDelta,
  appendToolActivity,
  conversationFromChatTranscript,
  conversationFromTranscript,
  markActivityAwaitingApproval,
  sealConversation,
  type ConversationEntry
} from './conversation'
import { connectionLabel, providerModelChip, type ConnectionState, type ProviderId } from '../../shared/provider'
import type { MetricsSample } from '../../shared/metrics'
import { parentDirectory, type WorkspaceChangedEvent } from '../../shared/workspaceEvents'
import { AgentPanel } from './components/AgentPanel'
import { BottomPanel } from './components/BottomPanel'
import { EditorArea } from './components/EditorArea'
import { Explorer } from './components/Explorer'
import { PublishProjectDialog } from './components/PublishProjectDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { TopBar } from './components/TopBar'
import type { EditorDiagnostic } from './EditorPane'
import { hasExternalChange, isDirty, isSessionRecord, secretLabel, type SessionRecord } from './editorState'
import type { DirectoryEntry } from '../../shared/ipc'

type WorkspaceInfo = { path: string; name: string }
type FileChange = {
  id: string
  relativePath: string
  changeType: string
  createdAt: string
  hasReverse: boolean
  reviewStatus: 'open' | 'kept' | 'undone'
}
type BufferState = { baseline: string; value: string }

type AppProps = {
  authUser: AuthPublicUser
  offlineGrace: boolean
  onLogout: () => void
}

const TERMINAL_MISSION_STATUSES = new Set([
  'completed',
  'partially_completed',
  'blocked',
  'failed',
  'cancelled',
  'interrupted'
])

function mergeWorkspaceEvents(
  previous: WorkspaceChangedEvent | null,
  next: WorkspaceChangedEvent
): WorkspaceChangedEvent {
  if (!previous || previous.root !== next.root) {
    return next
  }
  const byKey = new Map<string, WorkspaceChangedEvent['changes'][number]>()
  for (const change of [...previous.changes, ...next.changes]) {
    byKey.set(`${change.path}\0${change.kind}`, change)
  }
  const changes = [...byKey.values()].slice(0, 500)
  return {
    type: 'workspace.changed',
    root: next.root,
    changes,
    truncated: previous.truncated || next.truncated || byKey.size > 500,
    reason: next.reason ?? previous.reason
  }
}

export function App({ authUser, offlineGrace, onLogout }: AppProps) {
  const buffers = useRef(new Map<string, BufferState>())
  const reader = useRef<() => string>(() => '')
  const expandedRef = useRef<Record<string, DirectoryEntry[]>>({})
  const tabsRef = useRef<string[]>([])
  const staleDirsRef = useRef<Set<string>>(new Set())
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
  const [agentWidth, setAgentWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem('kern.agentWidth'))
      if (Number.isFinite(saved) && saved >= 300 && saved <= 720) {
        return saved
      }
    } catch {
      // ignore storage failures
    }
    return 380
  })
  const [bottomOpen, setBottomOpen] = useState(true)
  const [metrics, setMetrics] = useState<MetricsSample | null>(null)
  const [gitEntries, setGitEntries] = useState<Array<{ path: string; status: string }>>([])
  const [gitStatusByPath, setGitStatusByPath] = useState<Record<string, string>>({})
  const [gitError, setGitError] = useState<string | null>(null)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [gitProbe, setGitProbe] = useState<{
    isRepo: boolean
    hasCommits: boolean
  } | null>(null)
  const [gitScanning, setGitScanning] = useState(false)
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set())
  const [staleDirs, setStaleDirs] = useState<Set<string>>(new Set())
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishSuggestion, setPublishSuggestion] = useState(false)
  const [agentMission, setAgentMission] = useState<AgentMissionSummary | null>(null)
  const [agentMissions, setAgentMissions] = useState<AgentMissionSummary[]>([])
  const [agentChats, setAgentChats] = useState<AgentChatSummary[]>([])
  const [activeChat, setActiveChat] = useState<AgentChatSummary | null>(null)
  const [conversation, setConversation] = useState<ConversationEntry[]>([])
  const [agentTools, setAgentTools] = useState<AgentToolRecord[]>([])
  const [agentOperations, setAgentOperations] = useState<AgentOperationSummary[]>([])
  const [agentNotice, setAgentNotice] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const shownMission = useRef<string | null>(null)
  const activeChatId = useRef<string | null>(null)
  const pendingPrompt = useRef('')
  const armNextMission = useRef(false)
  const streamStarted = useRef(false)
  const bootstrapped = useRef(false)
  const treeRefreshInFlight = useRef(false)
  const gitRefreshInFlight = useRef(false)
  const gitRefreshQueued = useRef(false)
  const gitRefreshTimer = useRef<number | null>(null)
  const gitRefreshRunner = useRef<(options?: { probe?: boolean }) => Promise<void>>(async () => {})
  const workspaceChangeTimer = useRef<number | null>(null)
  const pendingWorkspaceEvent = useRef<WorkspaceChangedEvent | null>(null)
  const workspacePathRef = useRef<string | null>(null)
  expandedRef.current = expanded
  tabsRef.current = tabs
  staleDirsRef.current = staleDirs
  workspacePathRef.current = workspace?.path ?? null

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

  const refreshTree = useCallback(async (options?: { showLoading?: boolean }): Promise<void> => {
    if (treeRefreshInFlight.current) {
      return
    }
    treeRefreshInFlight.current = true
    const showLoading = options?.showLoading === true
    if (showLoading) {
      setTreeLoading(true)
    }
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
      setStaleDirs(new Set())
    } finally {
      treeRefreshInFlight.current = false
      if (showLoading) {
        setTreeLoading(false)
      }
    }
  }, [])

  const refreshGit = useCallback(async (options?: { probe?: boolean }): Promise<void> => {
    const root = workspacePathRef.current
    if (!root) {
      setGitEntries([])
      setGitStatusByPath({})
      setGitBranch(null)
      setGitError(null)
      setGitProbe(null)
      setGitScanning(false)
      return
    }
    if (gitRefreshInFlight.current) {
      gitRefreshQueued.current = true
      return
    }
    gitRefreshInFlight.current = true
    const showScan = options?.probe === true
    if (showScan) {
      setGitScanning(true)
    }
    try {
      const status = await window.kern.git.status()
      if (!status.ok) {
        setGitError(status.error)
        setGitEntries([])
        setGitBranch(null)
        setGitStatusByPath({})
      } else {
        setGitError(null)
        const info = status.data.branch
        const label = info.head ?? (info.detached ? 'detached' : info.unborn ? 'unborn' : '—')
        setGitBranch(label)
        const visible = status.data.entries.filter(
          (entry) => entry.status !== 'unmodified' && entry.status !== 'ignored'
        )
        setGitEntries(visible.map((entry) => ({ path: entry.path, status: entry.status })))
        const byPath: Record<string, string> = {}
        for (const entry of status.data.entries) {
          if (entry.status !== 'unmodified' && entry.status !== 'ignored') {
            byPath[entry.path] = entry.status
          }
        }
        setGitStatusByPath(byPath)
      }
      if (options?.probe) {
        const probe = await window.kern.git.publishProbe()
        if (probe.ok) {
          setGitProbe({ isRepo: probe.data.isRepo, hasCommits: probe.data.hasCommits })
        }
      }
    } finally {
      gitRefreshInFlight.current = false
      if (showScan) {
        setGitScanning(false)
      }
      if (gitRefreshQueued.current) {
        gitRefreshQueued.current = false
        window.setTimeout(() => {
          void gitRefreshRunner.current()
        }, 120)
      }
    }
  }, [])
  gitRefreshRunner.current = refreshGit

  const scheduleGitRefresh = useCallback(
    (options?: { probe?: boolean; delayMs?: number }): void => {
      if (gitRefreshTimer.current !== null) {
        window.clearTimeout(gitRefreshTimer.current)
      }
      gitRefreshTimer.current = window.setTimeout(() => {
        gitRefreshTimer.current = null
        void refreshGit(options)
      }, options?.delayMs ?? 450)
    },
    [refreshGit]
  )

  const applyWorkspaceChanged = useCallback(async (event: WorkspaceChangedEvent): Promise<void> => {
    const root = workspacePathRef.current
    if (!root || event.root !== root) {
      return
    }
    const gitOnly = event.changes.every((change) => {
      const normalized = change.path.replaceAll('\\', '/')
      return normalized === '.git' || normalized.startsWith('.git/')
    })
    if (gitOnly) {
      scheduleGitRefresh()
      return
    }

    const listed = await window.kern.workspace.list({ path: '.' })
    if (listed.ok) {
      setEntries(listed.data)
    }
    const dirsToRefresh = new Set<string>()
    const nextStale = new Set(staleDirsRef.current)
    const highlights = new Set<string>()
    for (const change of event.changes) {
      const normalized = change.path.replaceAll('\\', '/')
      if (normalized === '.git' || normalized.startsWith('.git/')) {
        continue
      }
      const dir =
        change.kind === 'refresh' && change.isDirectory !== false
          ? change.path
          : parentDirectory(change.path)
      if (dir === '.git' || dir.startsWith('.git/')) {
        continue
      }
      if (expandedRef.current[dir] !== undefined) {
        dirsToRefresh.add(dir)
      } else if (dir !== '.') {
        nextStale.add(dir)
      }
      if (change.kind === 'add' && change.isDirectory !== true) {
        highlights.add(change.path)
      }
      for (const tab of tabsRef.current) {
        if (change.path !== tab) {
          continue
        }
        if (change.kind === 'unlink') {
          const disk = await window.kern.workspace.read({ path: tab })
          if (!disk.ok) {
            setConflict({ path: tab, disk: '' })
            setError(`File removed on disk: ${tab}`)
          }
        } else if (change.kind === 'change') {
          const buffer = buffers.current.get(tab)
          if (!buffer) {
            continue
          }
          const disk = await window.kern.workspace.read({ path: tab })
          if (disk.ok && hasExternalChange(buffer.baseline, disk.data.content)) {
            setConflict({ path: tab, disk: disk.data.content })
            setError('Save blocked because the file changed on disk.')
            bump()
          }
        }
      }
    }
    const nextExpanded = { ...expandedRef.current }
    await Promise.all(
      [...dirsToRefresh].map(async (dir) => {
        const children = await window.kern.workspace.list({ path: dir })
        if (children.ok) {
          nextExpanded[dir] = children.data
        }
        nextStale.delete(dir)
      })
    )
    setExpanded(nextExpanded)
    setStaleDirs(nextStale)
    if (highlights.size > 0) {
      setHighlightedPaths(highlights)
      window.setTimeout(() => setHighlightedPaths(new Set()), 1_200)
    }
    scheduleGitRefresh()
  }, [scheduleGitRefresh])

  const handleWorkspaceChanged = useCallback(
    (event: WorkspaceChangedEvent): void => {
      pendingWorkspaceEvent.current = mergeWorkspaceEvents(pendingWorkspaceEvent.current, event)
      if (workspaceChangeTimer.current !== null) {
        return
      }
      workspaceChangeTimer.current = window.setTimeout(() => {
        workspaceChangeTimer.current = null
        const pending = pendingWorkspaceEvent.current
        pendingWorkspaceEvent.current = null
        if (pending) {
          void applyWorkspaceChanged(pending)
        }
      }, 200)
    },
    [applyWorkspaceChanged]
  )

  const maybePublishSuggestion = useCallback(async (): Promise<void> => {
    if (!workspace) {
      return
    }
    try {
      const key = `kern.publishDismiss:${workspace.path}`
      if (window.localStorage.getItem(key)) {
        return
      }
    } catch {
      // ignore storage
    }
    const probe = await window.kern.git.publishProbe()
    if (probe.ok && (!probe.data.isRepo || !probe.data.hasCommits)) {
      setPublishSuggestion(true)
    }
  }, [workspace])

  const refreshHistory = useCallback(async (chatId?: string | null): Promise<void> => {
    const scopedChatId = chatId === undefined ? activeChatId.current : chatId
    const [fileResult, missionResult] = await Promise.all([
      window.kern.history.fileChanges({
        limit: 100,
        status: 'open',
        ...(scopedChatId ? { chatId: scopedChatId } : {})
      }),
      window.kern.history.missions({ limit: 12 })
    ])
    if (fileResult.ok) {
      setChanges(fileResult.data)
    }
    if (missionResult.ok) {
      setSessions(missionResult.data.filter(isSessionRecord))
    }
  }, [])

  const refreshChats = useCallback(async (): Promise<void> => {
    const result = await window.kern.chat.list({ limit: 40 })
    if (result.ok) {
      setAgentChats(result.data)
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
    if (!activePath) {
      setDiagnostics([])
    }
  }, [activePath])

  const refreshAgentMissions = useCallback(async (): Promise<void> => {
    const result = await window.kern.agent.history({ limit: 20 })
    if (result.ok) {
      setAgentMissions(result.data)
    }
  }, [])

  const applyTranscript = useCallback((transcript: AgentTranscript | null): void => {
    if (!transcript) {
      return
    }
    shownMission.current = transcript.mission.id
    armNextMission.current = false
    streamStarted.current = false
    setAgentMission(transcript.mission)
    setConversation(conversationFromTranscript(transcript, transcript.mission.id))
    setAgentTools(transcript.tools)
    setAgentOperations(transcript.operations)
    setAgentNotice(transcript.mission.error ?? '')
  }, [])

  const clearChatView = useCallback((): void => {
    shownMission.current = null
    armNextMission.current = false
    streamStarted.current = false
    pendingPrompt.current = ''
    setAgentMission(null)
    setAgentMissions([])
    setConversation([])
    setAgentTools([])
    setAgentOperations([])
    setAgentNotice('')
    setChanges([])
  }, [])

  const applyChatTranscript = useCallback(
    (transcript: AgentChatTranscript | null): void => {
      if (!transcript) {
        clearChatView()
        setActiveChat(null)
        activeChatId.current = null
        return
      }
      activeChatId.current = transcript.chat.id
      setActiveChat(transcript.chat)
      setAgentMissions([...transcript.missions].reverse())
      setConversation(conversationFromChatTranscript(transcript))
      const latest = transcript.turns[transcript.turns.length - 1] ?? null
      const activeTurn =
        transcript.turns.find((turn) => !TERMINAL_MISSION_STATUSES.has(turn.mission.status)) ?? latest
      if (activeTurn) {
        shownMission.current = activeTurn.mission.id
        setAgentMission(activeTurn.mission)
        setAgentTools(activeTurn.tools)
        // Mission-scoped only — never flatten sibling missions into the active report.
        setAgentOperations(activeTurn.operations)
        setAgentNotice(activeTurn.mission.error ?? '')
      } else {
        shownMission.current = null
        setAgentMission(null)
        setAgentTools([])
        setAgentOperations([])
        setAgentNotice('')
      }
      armNextMission.current = false
      streamStarted.current = false
      void refreshHistory(transcript.chat.id)
    },
    [clearChatView, refreshHistory]
  )

  const hydrateAgentChat = useCallback(async (): Promise<void> => {
    const result = await window.kern.chat.hydrate()
    if (!result.ok) {
      setAgentNotice(result.error)
      return
    }
    if (!result.data) {
      clearChatView()
      setActiveChat(null)
      activeChatId.current = null
      await refreshChats()
      await refreshHistory(null)
      return
    }
    applyChatTranscript(result.data)
    await refreshChats()
  }, [applyChatTranscript, clearChatView, refreshChats, refreshHistory])

  useEffect(() => {
    if (bootstrapped.current) {
      return
    }
    bootstrapped.current = true
    void (async () => {
      const current = await window.kern.workspace.current()
      if (!current.ok) {
        setError(current.error)
        return
      }
      setWorkspace(current.data)
      if (current.data) {
        await refreshTree({ showLoading: true })
        await hydrateAgentChat()
        await refreshGit({ probe: true })
      }
      await refreshSecret()
      await refreshProvider()
    })()
  }, [hydrateAgentChat, refreshGit, refreshProvider, refreshSecret, refreshTree])

  useEffect(() => {
    if (!workspace) {
      return
    }
    const id = window.kern.workspace.onChanged((event) => {
      void handleWorkspaceChanged(event)
    })
    return () => window.kern.workspace.offChanged(id)
  }, [handleWorkspaceChanged, workspace])

  useEffect(() => {
    if (!workspace || !leftOpen) {
      void window.kern.metrics.subscribe({ visible: false })
      void window.kern.metrics.unsubscribe()
      setMetrics(null)
      return
    }
    void window.kern.metrics.subscribe({ visible: true })
    const id = window.kern.metrics.onSample((sample) => {
      setMetrics((previous) => {
        if (
          previous &&
          previous.cpuPct === sample.cpuPct &&
          previous.ramBytes === sample.ramBytes &&
          previous.tokens.tps === sample.tokens.tps &&
          previous.tokens.inTotal === sample.tokens.inTotal &&
          previous.tokens.outTotal === sample.tokens.outTotal
        ) {
          return previous
        }
        return sample
      })
    })
    return () => {
      window.kern.metrics.offSample(id)
      void window.kern.metrics.unsubscribe()
    }
  }, [leftOpen, workspace])

  useEffect(() => {
    const accepts = (missionId: string): boolean => {
      if (armNextMission.current) {
        armNextMission.current = false
        streamStarted.current = true
        shownMission.current = missionId
        setConversation((current) => {
          const prior = current.filter((entry) => !entry.streaming)
          const already = prior.some((entry) => entry.role === 'user' && entry.content === pendingPrompt.current)
          if (already) {
            return prior
          }
          return [
            ...prior,
            { key: `user-${Date.now()}`, role: 'user', content: pendingPrompt.current, streaming: false, activities: [] }
          ]
        })
        setAgentNotice('')
        return true
      }
      return shownMission.current === missionId
    }
    const id = window.kern.agent.onEvent((event: AgentEvent) => {
      if (event.type === 'status') {
        if (accepts(event.missionId)) {
          setConversation((current) => {
            const sealed = sealConversation(current)
            return event.status === 'awaiting_approval' ? markActivityAwaitingApproval(sealed) : sealed
          })
        }
        setAgentMission((current) =>
          current && current.id === event.missionId
            ? { ...current, status: event.status, title: event.title }
            : {
                id: event.missionId,
                chatId: current?.chatId ?? activeChatId.current,
                title: event.title,
                prompt: current?.prompt ?? event.title,
                status: event.status,
                iteration: 0,
                toolCalls: 0,
                summary: null,
                error: null,
                createdAt: '',
                updatedAt: ''
              }
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
            state: event.state,
            output: event.output ?? ''
          })
        )
        setAgentTools((current) => {
          const next = current.filter((tool) => tool.callId !== event.callId)
          return [...next, { callId: event.callId, name: event.name, argumentsText: event.argumentsText, state: event.state, output: event.output ?? '' }]
        })
        if (event.state === 'finished' && event.name === 'run_command') {
          scheduleGitRefresh()
        }
        return
      }
      if (event.type === 'proposal') {
        if (!accepts(event.missionId)) {
          return
        }
        setAgentOperations((current) => {
          const next = current.filter((item) => item.id !== event.operation.id)
          return [
            ...next,
            {
              id: event.operation.id,
              missionId: event.missionId,
              callId: '',
              kind: event.operation.kind,
              path: event.operation.path,
              toPath: event.operation.toPath,
              explanation: event.operation.explanation,
              status: event.operation.status,
              unifiedDiff: event.operation.unifiedDiff,
              destructive: event.operation.destructive,
              error: event.operation.error,
              contentFingerprint: event.operation.contentFingerprint,
              sourceOperationId: null,
              createdAt: '',
              resolvedAt: null
            }
          ]
        })
        if (event.operation.status === 'applied' || event.operation.status === 'pending') {
          void refreshHistory(activeChatId.current)
        }
        if (event.operation.status === 'applied') {
          scheduleGitRefresh()
        }
        return
      }
      if (event.type === 'error') {
        setAgentNotice(event.message)
        return
      }
      if (event.type === 'finished') {
        void maybePublishSuggestion()
      }
      if (event.usage) {
        setTokenNote(`${event.usage.totalTokens} tokens`)
      }
      setAgentMission((current) => (current && current.id === event.missionId ? { ...current, status: event.status, summary: event.summary || current.summary } : current))
      void refreshProvider()
      const chatId = activeChatId.current
      if (chatId && shownMission.current === event.missionId) {
        void window.kern.chat.get({ chatId }).then((result) => {
          if (result.ok && result.data && activeChatId.current === chatId) {
            applyChatTranscript(result.data)
          }
        })
      } else if (shownMission.current === event.missionId) {
        void window.kern.agent.transcript({ missionId: event.missionId }).then((result) => {
          if (result.ok && shownMission.current === event.missionId) {
            applyTranscript(result.data)
          }
        })
      }
      void refreshAgentMissions()
      void refreshChats()
      void refreshHistory(activeChatId.current)
    })
    void refreshAgentMissions()
    return () => window.kern.agent.offEvent(id)
  }, [
    applyChatTranscript,
    applyTranscript,
    maybePublishSuggestion,
    refreshAgentMissions,
    refreshChats,
    refreshHistory,
    refreshProvider,
    scheduleGitRefresh
  ])

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
    clearChatView()
    setActiveChat(null)
    activeChatId.current = null
    setAgentChats([])
    setWorkspace(selected.data.workspace)
    setError('')
    await refreshTree({ showLoading: true })
    await hydrateAgentChat()
    await refreshGit({ probe: true })
    setPublishSuggestion(false)
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
        setStaleDirs((current) => {
          const next = new Set(current)
          next.delete(entry.relativePath)
          return next
        })
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
    const continueFromMissionId =
      agentMission && TERMINAL_MISSION_STATUSES.has(agentMission.status) ? agentMission.id : undefined
    const chatId = activeChatId.current ?? undefined
    const result = await window.kern.agent.submit({
      prompt,
      ...(chatId ? { chatId } : {}),
      ...(continueFromMissionId ? { continueFromMissionId } : {})
    })
    if (!result.ok) {
      armNextMission.current = false
      setError(result.error)
      setAgentNotice(result.error)
      return
    }
    shownMission.current = result.data.missionId
    activeChatId.current = result.data.chatId
    armNextMission.current = false
    if (!streamStarted.current) {
      setConversation((current) => {
        const prior = current.filter((entry) => !entry.streaming)
        if (prior.some((entry) => entry.role === 'user' && entry.content === prompt)) {
          return prior
        }
        return [
          ...prior,
          {
            key: `${result.data.missionId}-user`,
            role: 'user',
            content: prompt,
            streaming: false,
            activities: []
          }
        ]
      })
      setAgentTools([])
      setAgentNotice('')
    }
    setAgentMission((current) =>
      current && current.id === result.data.missionId
        ? current
        : {
            id: result.data.missionId,
            chatId: result.data.chatId,
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
    void refreshAgentMissions()
    void refreshChats()
  }

  async function selectAgentMission(missionId: string): Promise<void> {
    if (agentRunning) {
      return
    }
    const result = await window.kern.agent.transcript({ missionId })
    if (!result.ok) {
      setAgentNotice(result.error)
      return
    }
    const transcript = result.data
    if (!transcript) {
      return
    }
    if (transcript.mission.chatId && transcript.mission.chatId === activeChatId.current) {
      shownMission.current = transcript.mission.id
      setAgentMission(transcript.mission)
      setAgentTools(transcript.tools)
      setAgentNotice(transcript.mission.error ?? '')
      return
    }
    if (transcript.mission.chatId) {
      await selectChat(transcript.mission.chatId)
      return
    }
    applyTranscript(transcript)
  }

  async function createChat(): Promise<void> {
    if (agentRunning) {
      setAgentNotice('Finish or cancel the current mission before starting a new chat.')
      return
    }
    const result = await window.kern.chat.create()
    if (!result.ok) {
      setAgentNotice(result.error)
      return
    }
    activeChatId.current = result.data.id
    setActiveChat(result.data)
    clearChatView()
    setActiveChat(result.data)
    activeChatId.current = result.data.id
    await refreshChats()
    await refreshHistory(result.data.id)
  }

  async function selectChat(chatId: string): Promise<void> {
    if (agentRunning && activeChatId.current !== chatId) {
      setAgentNotice('Cannot switch chats while a mission is running.')
      return
    }
    if (activeChatId.current === chatId) {
      return
    }
    const result = await window.kern.chat.select({ chatId })
    if (!result.ok) {
      setAgentNotice(result.error)
      return
    }
    applyChatTranscript(result.data)
    await refreshChats()
  }

  async function renameChat(chatId: string): Promise<void> {
    const current = agentChats.find((chat) => chat.id === chatId)
    const next = window.prompt('Rename chat', current?.title ?? '')
    if (!next?.trim()) {
      return
    }
    const result = await window.kern.chat.rename({ chatId, title: next.trim() })
    if (!result.ok) {
      setAgentNotice(result.error)
      return
    }
    if (activeChatId.current === chatId) {
      setActiveChat(result.data)
    }
    await refreshChats()
  }

  async function archiveChat(chatId: string): Promise<void> {
    if (agentRunning && activeChatId.current === chatId) {
      setAgentNotice('Cannot archive a chat while a mission is running.')
      return
    }
    if (!window.confirm('Archive this chat? Mission and operation history are kept.')) {
      return
    }
    const result = await window.kern.chat.archive({ chatId })
    if (!result.ok) {
      setAgentNotice(result.error)
      return
    }
    if (activeChatId.current === chatId) {
      await hydrateAgentChat()
    } else {
      await refreshChats()
    }
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

  async function approveOperation(operationId: string): Promise<void> {
    const operation = agentOperations.find((item) => item.id === operationId)
    const missionId = operation?.missionId ?? agentMission?.id
    if (!missionId) {
      return
    }
    const result = await window.kern.agent.approve({ missionId, operationId })
    if (!result.ok) {
      setAgentNotice(result.error)
      return
    }
    setAgentNotice('')
    await refreshTree()
    await refreshHistory(activeChatId.current)
    await refreshGit()
  }

  async function openGitFile(path: string): Promise<void> {
    const name = path.split('/').pop() ?? path
    await openEntry({ name, relativePath: path, kind: 'file', blocked: false })
  }

  function handleGitClick(): void {
    if (!workspace) {
      return
    }
    if (gitProbe && (!gitProbe.isRepo || !gitProbe.hasCommits)) {
      setPublishOpen(true)
      return
    }
    scheduleGitRefresh({ probe: true, delayMs: 0 })
  }

  function dismissPublishSuggestion(): void {
    setPublishSuggestion(false)
    if (!workspace) {
      return
    }
    try {
      window.localStorage.setItem(`kern.publishDismiss:${workspace.path}`, '1')
    } catch {
      // ignore
    }
  }

  async function keepAllChanges(): Promise<void> {
    const result = await window.kern.history.keepFileChanges({})
    if (!result.ok) {
      setError(result.error)
      return
    }
    if (result.data.skipped.length > 0) {
      setAgentNotice(
        `Kept ${result.data.kept.length}. Skipped ${result.data.skipped.length}: ${result.data.skipped
          .slice(0, 3)
          .map((item) => `${item.path || item.id}: ${item.error}`)
          .join('; ')}`
      )
    } else {
      setAgentNotice(result.data.kept.length > 0 ? `Kept ${result.data.kept.length} change${result.data.kept.length === 1 ? '' : 's'}.` : '')
    }
    await refreshHistory()
  }

  async function undoAllChanges(): Promise<void> {
    if (changes.length === 0) {
      return
    }
    if (!window.confirm(`Undo ${changes.length} recorded file change${changes.length === 1 ? '' : 's'}? Files that changed after KERN applied them will be skipped.`)) {
      return
    }
    const result = await window.kern.history.undoFileChanges({ confirm: true })
    if (!result.ok) {
      setError(result.error)
      return
    }
    if (result.data.failed.length > 0) {
      setAgentNotice(
        `Undid ${result.data.undone.length}. Failed ${result.data.failed.length}: ${result.data.failed
          .slice(0, 3)
          .map((item) => `${item.path || item.id}: ${item.error}`)
          .join('; ')}`
      )
    } else {
      setAgentNotice(`Undid ${result.data.undone.length} change${result.data.undone.length === 1 ? '' : 's'}.`)
    }
    await refreshHistory()
    await refreshTree()
  }

  async function reviewFileChange(changeId: string): Promise<{
    id: string
    relativePath: string
    changeType: string
    reviewStatus: 'open' | 'kept' | 'undone'
    hasReverse: boolean
    unifiedDiff: string
    error: string | null
  } | null> {
    const result = await window.kern.history.fileChangeReview({ id: changeId })
    if (!result.ok) {
      setAgentNotice(result.error)
      return null
    }
    return result.data
  }

  async function rejectOperation(operationId: string): Promise<void> {
    const operation = agentOperations.find((item) => item.id === operationId)
    const missionId = operation?.missionId ?? agentMission?.id
    if (!missionId) {
      return
    }
    const result = await window.kern.agent.reject({ missionId, operationId })
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

  const agentRunning = Boolean(agentMission && !TERMINAL_MISSION_STATUSES.has(agentMission.status))
  const modelChip = providerModelChip(providerChoice, connection)
  const providerName = modelChip.title
  const providerBadge = connectionLabel(connection, agentRunning)
  const gitLabel = gitError ? 'Git error' : gitBranch ? gitBranch : workspace ? 'No branch' : 'Git'
  const gitTitle =
    gitError ??
    (gitBranch ? `On branch ${gitBranch}` : gitProbe?.isRepo ? 'Git repository' : 'Initialize or publish this project')
  const gitDisabled = !workspace
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
        providerTitle={modelChip.detail}
        providerState={agentRunning ? 'running' : connection}
        missionTitle={agentRunning && agentMission ? agentMission.title : 'No active mission'}
        missionLive={agentRunning}
        onQuery={(value) => {
          setQuery(value)
          if (value.trim()) {
            setLeftOpen(true)
          }
        }}
        gitLabel={gitLabel}
        gitTitle={gitTitle}
        gitDisabled={gitDisabled}
        onGitClick={handleGitClick}
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
            metrics={metrics}
            metricsReason={workspace && !metrics ? 'Subscribe for live samples.' : undefined}
            gitEntries={gitEntries}
            gitError={gitError}
            highlightedPaths={highlightedPaths}
            scanning={gitScanning}
            gitStatusByPath={gitStatusByPath}
            onOpenGitFile={(path) => void openGitFile(path)}
            onPublish={() => setPublishOpen(true)}
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
            providerId={providerChoice}
            workspaceOpen={Boolean(workspace)}
            chat={activeChat}
            chats={agentChats}
            mission={agentMission}
            missions={agentMissions}
            running={agentRunning}
            messages={conversation}
            tools={agentTools}
            operations={agentOperations}
            notice={agentNotice}
            width={agentWidth}
            onWidthChange={(next) => {
              setAgentWidth(next)
              try {
                window.localStorage.setItem('kern.agentWidth', String(next))
              } catch {
                // ignore storage failures
              }
            }}
            onSubmit={(prompt) => void submitMission(prompt)}
            onNewChat={() => void createChat()}
            onSelectChat={(chatId) => void selectChat(chatId)}
            onRenameChat={(chatId) => void renameChat(chatId)}
            onArchiveChat={(chatId) => void archiveChat(chatId)}
            onSelectMission={(missionId) => void selectAgentMission(missionId)}
            onCancel={() => void cancelMission()}
            onApprove={(operationId) => void approveOperation(operationId)}
            onReject={(operationId) => void rejectOperation(operationId)}
            onKeepAll={() => void keepAllChanges()}
            onUndoAll={() => void undoAllChanges()}
            onReviewChange={(changeId) => reviewFileChange(changeId)}
            onProviderChange={(provider) => void chooseProvider(provider)}
            publishSuggestion={
              publishSuggestion
                ? {
                    message: 'This folder is not on git yet. Publish when you are ready to back up or share the project.',
                    onOpen: () => {
                      setPublishOpen(true)
                      dismissPublishSuggestion()
                    },
                    onDismiss: dismissPublishSuggestion
                  }
                : undefined
            }
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
      <PublishProjectDialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        onPublished={() => scheduleGitRefresh({ probe: true, delayMs: 0 })}
      />
      <SettingsDialog
        open={settingsOpen}
        provider={providerChoice}
        connectionState={connection}
        detail={providerDetail}
        secretDraft={secretDraft}
        authUser={authUser}
        offlineGrace={offlineGrace}
        onProvider={(provider) => void chooseProvider(provider)}
        onDraft={setSecretDraft}
        onSave={() => void saveSecret()}
        onClear={() => void clearSecret()}
        onCheck={() => void checkProvider()}
        onLogout={onLogout}
        onLogoutAll={onLogout}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}
