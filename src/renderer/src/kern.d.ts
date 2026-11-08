import type { editor } from 'monaco-editor'

import type { AuthPublicUser, AuthSessionState } from '../../shared/auth'
import type {
  AgentChatSummary,
  AgentChatTranscript,
  AgentEvent,
  AgentMissionSummary,
  AgentTranscript
} from '../../shared/agent'
import type { ConnectionState, ProviderId } from '../../shared/provider'
import type { GitIdentityResult, GitLogEntry, GitStatusResult } from '../../shared/git'
import type { MetricsSample } from '../../shared/metrics'
import type { WorkspaceChangedEvent } from '../../shared/workspaceEvents'

type KernResult<T> = { ok: true; data: T } | { ok: false; error: string }

type KernBridge = {
  workspace: {
    select: () => Promise<KernResult<{ canceled: true } | { canceled: false; workspace: { path: string; name: string } }>>
    current: () => Promise<KernResult<{ path: string; name: string } | null>>
    list: (payload: unknown) => Promise<KernResult<Array<{ name: string; relativePath: string; kind: 'file' | 'directory'; blocked: boolean }>>>
    read: (payload: unknown) => Promise<KernResult<{ content: string }>>
    write: (payload: unknown) => Promise<KernResult<{ saved: true }>>
    createFile: (payload: unknown) => Promise<KernResult<{ created: true }>>
    createDirectory: (payload: unknown) => Promise<KernResult<{ created: true }>>
    rename: (payload: unknown) => Promise<KernResult<{ renamed: true }>>
    remove: (payload: unknown) => Promise<KernResult<{ removed: true }>>
    onChanged: (callback: (event: WorkspaceChangedEvent) => void) => number
    offChanged: (id: number) => void
  }
  metrics: {
    subscribe: (payload: { visible: boolean }) => Promise<KernResult<{ ok: true }>>
    unsubscribe: () => Promise<KernResult<{ ok: true }>>
    onSample: (callback: (sample: MetricsSample) => void) => number
    offSample: (id: number) => void
  }
  git: {
    status: () => Promise<KernResult<GitStatusResult>>
    diff: (payload: { path?: string; staged?: boolean }) => Promise<KernResult<string>>
    log: (payload: { limit?: number }) => Promise<KernResult<GitLogEntry[]>>
    init: () => Promise<KernResult<{ initialized: true }>>
    stage: (payload: { paths: 'all' | string[] }) => Promise<KernResult<{ staged: true }>>
    unstage: (payload: { paths: 'all' | string[] }) => Promise<KernResult<{ unstaged: true }>>
    commit: (payload: { message: string }) => Promise<KernResult<{ hash: string }>>
    createBranch: (payload: { name: string }) => Promise<KernResult<{ created: true }>>
    switch: (payload: { name: string }) => Promise<KernResult<{ switched: true }>>
    addRemote: (payload: { name: string; url: string }) => Promise<KernResult<{ added: true }>>
    push: (payload: { remote?: string; branch?: string; setUpstream?: boolean }) => Promise<
      KernResult<{ exitCode: number; stdout: string; stderr: string; durationMs: number; truncated: boolean }>
    >
    pull: (payload: { remote?: string; branch?: string }) => Promise<KernResult<{ pulled: true }>>
    identity: () => Promise<KernResult<GitIdentityResult>>
    setIdentity: (payload: { local: true; name: string; email: string }) => Promise<KernResult<{ saved: true }>>
    ignorePreview: (payload: { stack?: 'node' | 'expo' | 'react-native' }) => Promise<
      KernResult<{ content: string; stack: string; exists: boolean }>
    >
    ignoreWrite: (payload: { content: string; confirm: true }) => Promise<KernResult<{ saved: true }>>
    scanCommit: (payload: { paths?: string[] }) => Promise<
      KernResult<Array<{ path: string; reason: 'env_file' | 'private_key' | 'large_file'; sizeBytes?: number }>>
    >
    exportPreview: (payload: { includeGit?: boolean }) => Promise<
      KernResult<{ fileCount: number; totalBytes: number; paths: string[] }>
    >
    export: (payload: { includeGit?: boolean; destination?: string }) => Promise<
      KernResult<{ fileCount: number; bytes: number; destination: string }>
    >
    publishProbe: () => Promise<
      KernResult<{
        isRepo: boolean
        hasCommits: boolean
        identity: GitIdentityResult
        remotes: Array<{ name: string; fetchUrl: string | null; pushUrl: string | null }>
        gitignoreExists: boolean
        ghAvailable: boolean
      }>
    >
  }
  secrets: {
    status: () => Promise<KernResult<{ configured: boolean; storageAvailable: boolean }>>
    set: (payload: unknown) => Promise<KernResult<{ stored: true }>>
    clear: () => Promise<KernResult<{ cleared: true }>>
    setCursor: (payload: unknown) => Promise<KernResult<{ stored: true }>>
    clearCursor: () => Promise<KernResult<{ cleared: true }>>
  }
  provider: {
    get: () => Promise<KernResult<{
      provider: ProviderId
      state: ConnectionState
      bharatCodeConfigured: boolean
      cursorConfigured: boolean
      detail: string
    }>>
    set: (payload: unknown) => Promise<KernResult<{
      provider: ProviderId
      state: ConnectionState
      bharatCodeConfigured: boolean
      cursorConfigured: boolean
      detail: string
    }>>
    check: () => Promise<KernResult<{
      provider: ProviderId
      state: ConnectionState
      bharatCodeConfigured: boolean
      cursorConfigured: boolean
      detail: string
    }>>
  }
  terminal: {
    start: () => Promise<KernResult<{ shell: string }>>
    write: (payload: unknown) => Promise<KernResult<{ written: true }>>
    resize: (payload: unknown) => Promise<KernResult<{ resized: true }>>
    cancel: () => Promise<KernResult<{ stopped: boolean }>>
    onData: (callback: (data: string) => void) => number
    offData: (id: number) => void
    onExit: (callback: (exitCode: number) => void) => number
    offExit: (id: number) => void
  }
  history: {
    missions: (payload: unknown) => Promise<
      KernResult<Array<{ id: string; title: string; status: string; createdAt: string }>>
    >
    fileChanges: (payload: unknown) => Promise<
      KernResult<
        Array<{
          id: string
          relativePath: string
          changeType: string
          createdAt: string
          hasReverse: boolean
          reviewStatus: 'open' | 'kept' | 'undone'
        }>
      >
    >
    keepFileChanges: (payload: unknown) => Promise<
      KernResult<{ kept: string[]; skipped: Array<{ id: string; path: string; error: string }> }>
    >
    undoFileChanges: (payload: unknown) => Promise<
      KernResult<{ undone: string[]; failed: Array<{ id: string; path: string; error: string }> }>
    >
    fileChangeReview: (payload: unknown) => Promise<
      KernResult<{
        id: string
        relativePath: string
        changeType: string
        reviewStatus: 'open' | 'kept' | 'undone'
        hasReverse: boolean
        unifiedDiff: string
        error: string | null
      }>
    >
  }
  chat: {
    list: (payload: unknown) => Promise<KernResult<AgentChatSummary[]>>
    create: () => Promise<KernResult<AgentChatSummary>>
    get: (payload: unknown) => Promise<KernResult<AgentChatTranscript | null>>
    select: (payload: unknown) => Promise<KernResult<AgentChatTranscript>>
    rename: (payload: unknown) => Promise<KernResult<AgentChatSummary>>
    archive: (payload: unknown) => Promise<KernResult<AgentChatSummary>>
    hydrate: () => Promise<KernResult<AgentChatTranscript | null>>
  }
  agent: {
    submit: (payload: unknown) => Promise<KernResult<{ missionId: string; chatId: string }>>
    cancel: (payload: unknown) => Promise<KernResult<{ cancelled: boolean }>>
    approve: (payload: unknown) => Promise<KernResult<{ applied: boolean; duplicate: boolean; status: string }>>
    reject: (payload: unknown) => Promise<KernResult<{ rejected: boolean }>>
    restore: (payload: unknown) => Promise<KernResult<{ restored: true }>>
    current: () => Promise<KernResult<AgentTranscript | null>>
    history: (payload: unknown) => Promise<KernResult<AgentMissionSummary[]>>
    transcript: (payload: unknown) => Promise<KernResult<AgentTranscript | null>>
    onEvent: (callback: (event: AgentEvent) => void) => number
    offEvent: (id: number) => void
  }
  auth: {
    status: () => Promise<KernResult<AuthSessionState>>
    register: (payload: unknown) => Promise<KernResult<AuthSessionState>>
    login: (payload: unknown) => Promise<KernResult<AuthSessionState>>
    verify: (payload: unknown) => Promise<KernResult<AuthSessionState>>
    resend: (payload: unknown) => Promise<KernResult<{ sent: true }>>
    forgot: (payload: unknown) => Promise<KernResult<{ accepted: true }>>
    reset: (payload: unknown) => Promise<KernResult<{ reset: true }>>
    logout: () => Promise<KernResult<AuthSessionState>>
    logoutAll: () => Promise<KernResult<AuthSessionState>>
    me: () => Promise<KernResult<AuthPublicUser>>
    devices: () => Promise<
      KernResult<
        Array<{
          id: string
          deviceName: string
          platform: string
          appVersion: string
          lastSeenAt: string
          createdAt: string
          current: boolean
        }>
      >
    >
    retry: () => Promise<KernResult<AuthSessionState>>
  }
}

declare global {
  interface Window {
    kern: KernBridge
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker
    }
    __kernEditors?: () => readonly editor.ICodeEditor[]
    __kernAcceptanceSecret?: string
  }
}

export {}
