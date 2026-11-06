import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { agentEventSchema, type AgentEvent } from '../shared/agent.ts'
import {
  IpcChannel,
  parseRequest,
  terminalDataSchema,
  terminalExitSchema,
  type IpcResult,
  type RequestChannel
} from '../shared/ipc.ts'

let nextSubscription = 1
const dataListeners = new Map<number, (event: IpcRendererEvent, payload: unknown) => void>()
const exitListeners = new Map<number, (event: IpcRendererEvent, payload: unknown) => void>()
const agentListeners = new Map<number, (event: IpcRendererEvent, payload: unknown) => void>()

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
    remove: (payload: unknown) => invoke(IpcChannel.workspaceRemove, payload)
  },
  secrets: {
    status: () => invoke(IpcChannel.secretsStatus, {}),
    set: (payload: unknown) => invoke(IpcChannel.secretsSet, payload),
    clear: () => invoke(IpcChannel.secretsClear, {})
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
    fileChanges: (payload: unknown) => invoke(IpcChannel.historyFileChanges, payload)
  },
  agent: {
    submit: (payload: unknown) => invoke(IpcChannel.agentSubmit, payload),
    cancel: (payload: unknown) => invoke(IpcChannel.agentCancel, payload),
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
  }
}

contextBridge.exposeInMainWorld('kern', kern)
