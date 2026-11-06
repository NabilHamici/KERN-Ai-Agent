import type { editor } from 'monaco-editor'

import type { AgentEvent, AgentMissionSummary, AgentTranscript } from '../../shared/agent'

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
  }
  secrets: {
    status: () => Promise<KernResult<{ configured: boolean; storageAvailable: boolean }>>
    set: (payload: unknown) => Promise<KernResult<{ stored: true }>>
    clear: () => Promise<KernResult<{ cleared: true }>>
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
      KernResult<Array<{ relativePath: string; changeType: string; createdAt: string; hasReverse: boolean }>>
    >
  }
  agent: {
    submit: (payload: unknown) => Promise<KernResult<{ missionId: string }>>
    cancel: (payload: unknown) => Promise<KernResult<{ cancelled: boolean }>>
    current: () => Promise<KernResult<AgentTranscript | null>>
    history: (payload: unknown) => Promise<KernResult<AgentMissionSummary[]>>
    transcript: (payload: unknown) => Promise<KernResult<AgentTranscript | null>>
    onEvent: (callback: (event: AgentEvent) => void) => number
    offEvent: (id: number) => void
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
