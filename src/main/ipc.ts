import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { AgentError } from '../shared/agent.ts'
import { PathJailError } from './security/pathJail.ts'
import { IpcChannel, parseRequest, requestSchemas, type IpcResult, type RequestChannel } from '../shared/ipc.ts'
import { clearSecret, secretStatus, storeSecret } from './services/secrets.ts'
import type { AgentRuntime } from './agent/runtime.ts'
import type { WorkspaceService } from './services/workspace.ts'
import type { TerminalService } from './services/terminal.ts'

const KNOWN_ERRORS = new Set([
  'Secure storage is unavailable on this system',
  'No workspace is open',
  'No shell is available',
  'Terminal is not running',
  'Confirmation is required',
  'Untrusted IPC sender'
])

export type IpcHost = {
  getWindow: () => BrowserWindow | null
  workspace: WorkspaceService
  terminal: TerminalService
  agent: AgentRuntime
  userData: string
}

function publicError(error: unknown): string {
  if (error instanceof AgentError || error instanceof PathJailError) {
    return error.message
  }
  if (error instanceof Error && KNOWN_ERRORS.has(error.message)) {
    return error.message
  }
  return 'Request failed'
}

function trusted(event: IpcMainInvokeEvent, getWindow: () => BrowserWindow | null): boolean {
  const win = getWindow()
  return win !== null && event.sender.id === win.webContents.id && event.senderFrame === event.sender.mainFrame
}

async function dispatch(channel: RequestChannel, payload: unknown, host: IpcHost): Promise<unknown> {
  const win = host.getWindow()
  switch (channel) {
    case IpcChannel.workspaceSelect: {
      if (!win) {
        throw new Error('Request failed')
      }
      const selected = await dialog.showOpenDialog(win, {
        title: 'Open folder',
        properties: ['openDirectory']
      })
      if (selected.canceled || selected.filePaths.length !== 1) {
        return { canceled: true as const }
      }
      const workspace = host.workspace.open(selected.filePaths[0]!)
      return { canceled: false as const, workspace }
    }
    case IpcChannel.workspaceCurrent:
      return host.workspace.current()
    case IpcChannel.workspaceList: {
      const { path } = payload as { path: string }
      return host.workspace.list(path)
    }
    case IpcChannel.workspaceRead: {
      const { path } = payload as { path: string }
      return { content: host.workspace.read(path) }
    }
    case IpcChannel.workspaceWrite: {
      const { path, content } = payload as { path: string; content: string }
      host.workspace.write(path, content)
      return { saved: true as const }
    }
    case IpcChannel.workspaceCreateFile: {
      const { path, content } = payload as { path: string; content?: string }
      host.workspace.createFile(path, content)
      return { created: true as const }
    }
    case IpcChannel.workspaceCreateDirectory: {
      const { path } = payload as { path: string }
      host.workspace.createDirectory(path)
      return { created: true as const }
    }
    case IpcChannel.workspaceRename: {
      const { from, to, confirm } = payload as { from: string; to: string; confirm: true }
      host.workspace.rename(from, to, confirm)
      return { renamed: true as const }
    }
    case IpcChannel.workspaceRemove: {
      const { path, confirm } = payload as { path: string; confirm: true }
      host.workspace.remove(path, confirm)
      return { removed: true as const }
    }
    case IpcChannel.secretsStatus:
      return secretStatus(host.userData)
    case IpcChannel.secretsSet: {
      const { apiKey } = payload as { apiKey: string }
      await storeSecret(host.userData, apiKey)
      return { stored: true as const }
    }
    case IpcChannel.secretsClear:
      await clearSecret(host.userData)
      return { cleared: true as const }
    case IpcChannel.terminalStart: {
      const current = host.workspace.current()
      if (!current) {
        throw new PathJailError('No workspace is open')
      }
      return host.terminal.start(
        current.path,
        (data) => {
          host.getWindow()?.webContents.send(IpcChannel.terminalData, { data })
        },
        (exitCode) => {
          host.getWindow()?.webContents.send(IpcChannel.terminalExit, { exitCode })
        }
      )
    }
    case IpcChannel.terminalWrite: {
      const { data } = payload as { data: string }
      host.terminal.write(data)
      return { written: true as const }
    }
    case IpcChannel.terminalResize: {
      const { cols, rows } = payload as { cols: number; rows: number }
      host.terminal.resize(cols, rows)
      return { resized: true as const }
    }
    case IpcChannel.terminalCancel:
      return host.terminal.cancel()
    case IpcChannel.historyMissions: {
      const { limit } = payload as { limit?: number }
      return host.workspace.listMissions(limit)
    }
    case IpcChannel.historyFileChanges: {
      const { limit } = payload as { limit?: number }
      return host.workspace.listFileChanges(limit)
    }
    case IpcChannel.agentSubmit: {
      const { prompt } = payload as { prompt: string }
      return host.agent.submit(prompt)
    }
    case IpcChannel.agentCancel: {
      const { missionId } = payload as { missionId: string }
      return host.agent.cancel(missionId)
    }
    case IpcChannel.agentCurrent:
      return host.agent.current()
    case IpcChannel.agentHistory: {
      const { limit } = payload as { limit?: number }
      return host.agent.history(limit)
    }
    case IpcChannel.agentTranscript: {
      const { missionId } = payload as { missionId: string }
      return host.agent.transcript(missionId)
    }
    default: {
      const unexpected: never = channel
      throw new Error(`Invalid request ${String(unexpected)}`)
    }
  }
}

export function registerIpc(host: IpcHost): void {
  for (const channel of Object.keys(requestSchemas) as RequestChannel[]) {
    ipcMain.handle(channel, async (event, payload): Promise<IpcResult<unknown>> => {
      if (!trusted(event, host.getWindow)) {
        return { ok: false, error: 'Untrusted IPC sender' }
      }
      const parsed = parseRequest(channel, payload)
      if (!parsed.ok) {
        return parsed
      }
      try {
        return { ok: true, data: await dispatch(channel, parsed.data, host) }
      } catch (error) {
        return { ok: false, error: publicError(error) }
      }
    })
  }
}

