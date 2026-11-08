import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { agentEventSchema, type AgentEvent } from '../shared/agent.ts'
import {
  IpcChannel,
  parseRequest,
  terminalDataSchema,
  terminalExitSchema,
  workspaceChangedEventSchema,
  type IpcResult,
  type RequestChannel
} from '../shared/ipc.ts'
import { metricsSampleSchema } from '../shared/metrics.ts'

let nextSubscription = 1
const dataListeners = new Map<number, (event: IpcRendererEvent, payload: unknown) => void>()
const exitListeners = new Map<number, (event: IpcRendererEvent, payload: unknown) => void>()
const agentListeners = new Map<number, (event: IpcRendererEvent, payload: unknown) => void>()
const metricsListeners = new Map<number, (event: IpcRendererEvent, payload: unknown) => void>()
const workspaceListeners = new Map<number, (event: IpcRendererEvent, payload: unknown) => void>()

async function invoke<T>(channel: RequestChannel, payload: unknown): Promise<IpcResult<T>> {
  const parsed = parseRequest(channel, payload)
  if (!parsed.ok) {
    return parsed
  }
  const result: unknown = await ipcRenderer.invoke(channel, parsed.data)
  if (!result || typeof result !== 'object' || !('ok' in result) || typeof result.ok !== 'boolean') {
    return { ok: false, error: 'Invalid response' }
  }
  return result as IpcResult<T>
}

const kern = {
  workspace: {
    select: () => invoke(IpcChannel.workspaceSelect, {}),
    current: () => invoke(IpcChannel.workspaceCurrent, {}),
    list: (payload: unknown) => invoke(IpcChannel.workspaceList, payload),
    read: (payload: unknown) => invoke(IpcChannel.workspaceRead, payload),
    write: (payload: unknown) => invoke(IpcChannel.workspaceWrite, payload),
    createFile: (payload: unknown) => invoke(IpcChannel.workspaceCreateFile, payload),
    createDirectory: (payload: unknown) => invoke(IpcChannel.workspaceCreateDirectory, payload),
    rename: (payload: unknown) => invoke(IpcChannel.workspaceRename, payload),
    remove: (payload: unknown) => invoke(IpcChannel.workspaceRemove, payload),
    onChanged: (callback: (event: import('../shared/workspaceEvents.ts').WorkspaceChangedEvent) => void): number => {
      const id = nextSubscription++
      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        const parsed = workspaceChangedEventSchema.safeParse(payload)
        if (parsed.success) {
          callback(parsed.data)
        }
      }
      workspaceListeners.set(id, listener)
      ipcRenderer.on(IpcChannel.workspaceChanged, listener)
      return id
    },
    offChanged: (id: number): void => {
      const listener = workspaceListeners.get(id)
      if (!listener) {
        return
      }
      workspaceListeners.delete(id)
      ipcRenderer.removeListener(IpcChannel.workspaceChanged, listener)
    }
  },
  secrets: {
    status: () => invoke(IpcChannel.secretsStatus, {}),
    set: (payload: unknown) => invoke(IpcChannel.secretsSet, payload),
    clear: () => invoke(IpcChannel.secretsClear, {}),
    setCursor: (payload: unknown) => invoke(IpcChannel.secretsSetCursor, payload),
    clearCursor: () => invoke(IpcChannel.secretsClearCursor, {})
  },
  provider: {
    get: () => invoke(IpcChannel.providerGet, {}),
    set: (payload: unknown) => invoke(IpcChannel.providerSet, payload),
    check: () => invoke(IpcChannel.providerCheck, {})
  },
  terminal: {
    start: () => invoke(IpcChannel.terminalStart, {}),
    write: (payload: unknown) => invoke(IpcChannel.terminalWrite, payload),
    resize: (payload: unknown) => invoke(IpcChannel.terminalResize, payload),
    cancel: () => invoke(IpcChannel.terminalCancel, {}),
    onData: (callback: (data: string) => void): number => {
      const id = nextSubscription++
      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        const parsed = terminalDataSchema.safeParse(payload)
        if (parsed.success) {
          callback(parsed.data.data)
        }
      }
      dataListeners.set(id, listener)
      ipcRenderer.on(IpcChannel.terminalData, listener)
      return id
    },
    offData: (id: number): void => {
      const listener = dataListeners.get(id)
      if (!listener) {
        return
      }
      dataListeners.delete(id)
      ipcRenderer.removeListener(IpcChannel.terminalData, listener)
    },
    onExit: (callback: (exitCode: number) => void): number => {
      const id = nextSubscription++
      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        const parsed = terminalExitSchema.safeParse(payload)
        if (parsed.success) {
          callback(parsed.data.exitCode)
        }
      }
      exitListeners.set(id, listener)
      ipcRenderer.on(IpcChannel.terminalExit, listener)
      return id
    },
    offExit: (id: number): void => {
      const listener = exitListeners.get(id)
      if (!listener) {
        return
      }
      exitListeners.delete(id)
      ipcRenderer.removeListener(IpcChannel.terminalExit, listener)
    }
  },
  history: {
    missions: (payload: unknown) => invoke(IpcChannel.historyMissions, payload),
    fileChanges: (payload: unknown) => invoke(IpcChannel.historyFileChanges, payload),
    keepFileChanges: (payload: unknown) => invoke(IpcChannel.historyKeepFileChanges, payload),
    undoFileChanges: (payload: unknown) => invoke(IpcChannel.historyUndoFileChanges, payload),
    fileChangeReview: (payload: unknown) => invoke(IpcChannel.historyFileChangeReview, payload)
  },
  chat: {
    list: (payload: unknown) => invoke(IpcChannel.chatList, payload),
    create: () => invoke(IpcChannel.chatCreate, {}),
    get: (payload: unknown) => invoke(IpcChannel.chatGet, payload),
    select: (payload: unknown) => invoke(IpcChannel.chatSelect, payload),
    rename: (payload: unknown) => invoke(IpcChannel.chatRename, payload),
    archive: (payload: unknown) => invoke(IpcChannel.chatArchive, payload),
    hydrate: () => invoke(IpcChannel.chatHydrate, {})
  },
  agent: {
    submit: (payload: unknown) => invoke(IpcChannel.agentSubmit, payload),
    cancel: (payload: unknown) => invoke(IpcChannel.agentCancel, payload),
    approve: (payload: unknown) => invoke(IpcChannel.agentApprove, payload),
    reject: (payload: unknown) => invoke(IpcChannel.agentReject, payload),
    restore: (payload: unknown) => invoke(IpcChannel.agentRestore, payload),
    current: () => invoke(IpcChannel.agentCurrent, {}),
    history: (payload: unknown) => invoke(IpcChannel.agentHistory, payload),
    transcript: (payload: unknown) => invoke(IpcChannel.agentTranscript, payload),
    onEvent: (callback: (event: AgentEvent) => void): number => {
      const id = nextSubscription++
      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        const parsed = agentEventSchema.safeParse(payload)
        if (parsed.success) {
          callback(parsed.data)
        }
      }
      agentListeners.set(id, listener)
      ipcRenderer.on(IpcChannel.agentEvent, listener)
      return id
    },
    offEvent: (id: number): void => {
      const listener = agentListeners.get(id)
      if (!listener) {
        return
      }
      agentListeners.delete(id)
      ipcRenderer.removeListener(IpcChannel.agentEvent, listener)
    }
  },
  metrics: {
    subscribe: (payload: unknown) => invoke(IpcChannel.metricsSubscribe, payload),
    unsubscribe: () => invoke(IpcChannel.metricsUnsubscribe, {}),
    onSample: (callback: (sample: import('../shared/metrics.ts').MetricsSample) => void): number => {
      const id = nextSubscription++
      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        const parsed = metricsSampleSchema.safeParse(payload)
        if (parsed.success) {
          callback(parsed.data)
        }
      }
      metricsListeners.set(id, listener)
      ipcRenderer.on(IpcChannel.metricsSample, listener)
      return id
    },
    offSample: (id: number): void => {
      const listener = metricsListeners.get(id)
      if (!listener) {
        return
      }
      metricsListeners.delete(id)
      ipcRenderer.removeListener(IpcChannel.metricsSample, listener)
    }
  },
  git: {
    status: () => invoke(IpcChannel.gitStatus, {}),
    diff: (payload: unknown) => invoke(IpcChannel.gitDiff, payload),
    log: (payload: unknown) => invoke(IpcChannel.gitLog, payload),
    init: () => invoke(IpcChannel.gitInit, {}),
    stage: (payload: unknown) => invoke(IpcChannel.gitStage, payload),
    unstage: (payload: unknown) => invoke(IpcChannel.gitUnstage, payload),
    commit: (payload: unknown) => invoke(IpcChannel.gitCommit, payload),
    createBranch: (payload: unknown) => invoke(IpcChannel.gitCreateBranch, payload),
    switch: (payload: unknown) => invoke(IpcChannel.gitSwitch, payload),
    addRemote: (payload: unknown) => invoke(IpcChannel.gitAddRemote, payload),
    push: (payload: unknown) => invoke(IpcChannel.gitPush, payload),
    pull: (payload: unknown) => invoke(IpcChannel.gitPull, payload),
    identity: () => invoke(IpcChannel.gitIdentity, {}),
    setIdentity: (payload: unknown) => invoke(IpcChannel.gitSetIdentity, payload),
    ignorePreview: (payload: unknown) => invoke(IpcChannel.gitIgnorePreview, payload),
    ignoreWrite: (payload: unknown) => invoke(IpcChannel.gitIgnoreWrite, payload),
    scanCommit: (payload: unknown) => invoke(IpcChannel.gitScanCommit, payload),
    exportPreview: (payload: unknown) => invoke(IpcChannel.gitExportPreview, payload),
    export: (payload: unknown) => invoke(IpcChannel.gitExport, payload),
    publishProbe: () => invoke(IpcChannel.gitPublishProbe, {})
  },
  auth: {
    status: () => invoke(IpcChannel.authStatus, {}),
    register: (payload: unknown) => invoke(IpcChannel.authRegister, payload),
    login: (payload: unknown) => invoke(IpcChannel.authLogin, payload),
    verify: (payload: unknown) => invoke(IpcChannel.authVerify, payload),
    resend: (payload: unknown) => invoke(IpcChannel.authResend, payload),
    forgot: (payload: unknown) => invoke(IpcChannel.authForgot, payload),
    reset: (payload: unknown) => invoke(IpcChannel.authReset, payload),
    logout: () => invoke(IpcChannel.authLogout, {}),
    logoutAll: () => invoke(IpcChannel.authLogoutAll, {}),
    me: () => invoke(IpcChannel.authMe, {}),
    devices: () => invoke(IpcChannel.authDevices, {}),
    retry: () => invoke(IpcChannel.authRetry, {})
  }
}

contextBridge.exposeInMainWorld('kern', kern)
