import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { AgentError } from '../shared/agent.ts'
import { findRiskyCommitPaths, generateGitignore } from '../shared/git.ts'
import { PathJailError } from './security/pathJail.ts'
import {
  IpcChannel,
  isPublicAuthChannel,
  parseRequest,
  requestSchemas,
  type IpcResult,
  type RequestChannel
} from '../shared/ipc.ts'
import type { AuthSessionService } from './services/authSession.ts'
import type { ProviderId } from '../shared/provider.ts'
import { probeBharatCode } from './agent/provider.ts'
import { cursorUsesStoredLogin, probeCursorAccount } from './agent/cursorSdk.ts'
import { checkSelectedProvider, providerSnapshot, rememberConnection, writeProviderId } from './agent/providerSettings.ts'
import { clearCursorSecret, clearSecret, readCursorSecret, readSecret, secretStatus, storeCursorSecret, storeSecret } from './services/secrets.ts'
import type { MissionDatabase } from './services/database.ts'
import type { AgentRuntime } from './agent/runtime.ts'
import type { WorkspaceService } from './services/workspace.ts'
import type { TerminalService } from './services/terminal.ts'
import { GitError, GitService } from './services/gitService.ts'
import { listExportPaths, writeExportZip } from './services/projectExport.ts'

const execFileAsync = promisify(execFile)

const KNOWN_ERRORS = new Set([
  'Secure storage is unavailable on this system',
  'No workspace is open',
  'No shell is available',
  'Terminal is not running',
  'Confirmation is required',
  'Untrusted IPC sender',
  'Authentication required',
  'backend_unavailable'
])

export type IpcHost = {
  getWindow: () => BrowserWindow | null
  workspace: WorkspaceService
  terminal: TerminalService
  agent: AgentRuntime
  database: MissionDatabase
  userData: string
  auth: AuthSessionService
  watcher: import('./services/workspaceWatcher.ts').WorkspaceWatcher
  metrics: import('./services/metricsService.ts').MetricsService
  audit: import('./services/auditLog.ts').AuditLog
  onWorkspaceOpened?: (root: string) => void
}

function requireGit(host: IpcHost): GitService {
  const current = host.workspace.current()
  if (!current) {
    throw new PathJailError('No workspace is open')
  }
  return new GitService(current.path)
}

function auditGit(host: IpcHost, action: string, detail?: Record<string, unknown>): void {
  host.audit.write({ actor: 'user', action, detail })
}

function detectProjectStack(root: string): 'node' | 'expo' | 'react-native' {
  const pkgPath = path.join(root, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return 'node'
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps.expo) {
      return 'expo'
    }
    if (deps['react-native']) {
      return 'react-native'
    }
  } catch {
    // ignore invalid package.json
  }
  return 'node'
}

async function ghCliAvailable(): Promise<boolean> {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileAsync(cmd, ['gh'], { timeout: 3_000 })
    return Boolean(stdout.trim())
  } catch {
    return false
  }
}

async function gitExecOk(git: GitService, args: string[], context: string): Promise<void> {
  const result = await git.exec(args)
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 2_000)
    throw new GitError('git_failed', `${context} failed${detail ? `: ${detail}` : '.'}`)
  }
}

function withWatcherSuppress(host: IpcHost, run: () => void): void {
  host.watcher.suppress()
  try {
    run()
  } finally {
    host.watcher.suppress()
  }
}

/** git status/index refresh can rewrite .git/index; suppress to avoid watcher feedback loops. */
async function withGitWatcherQuiet<T>(host: IpcHost, run: () => Promise<T>, ms = 1_200): Promise<T> {
  host.watcher.suppress(ms)
  try {
    return await run()
  } finally {
    host.watcher.suppress(ms)
  }
}

async function configuredProviders(userData: string): Promise<{ bharatcode: boolean; cursor: boolean }> {
  const status = await secretStatus(userData)
  const loggedIn = await cursorUsesStoredLogin()
  const envKey = Boolean(process.env.CURSOR_API_KEY?.trim())
  return { bharatcode: status.configured, cursor: envKey || loggedIn }
}

async function currentProvider(host: IpcHost) {
  return providerSnapshot(host.database, await configuredProviders(host.userData))
}

function publicError(error: unknown): string {
  if (error instanceof AgentError || error instanceof PathJailError || error instanceof GitError) {
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
  if (!isPublicAuthChannel(channel) && channel !== IpcChannel.authLogout && channel !== IpcChannel.authLogoutAll && channel !== IpcChannel.authMe && channel !== IpcChannel.authDevices) {
    if (!host.auth.isAuthenticated()) {
      throw new Error('Authentication required')
    }
  }
  if ((channel === IpcChannel.authLogoutAll || channel === IpcChannel.authMe || channel === IpcChannel.authDevices) && !host.auth.isAuthenticated()) {
    throw new Error('Authentication required')
  }
  const win = host.getWindow()
  switch (channel) {
    case IpcChannel.authStatus:
      return host.auth.bootstrap()
    case IpcChannel.authRetry:
      return host.auth.bootstrap()
    case IpcChannel.authRegister: {
      const body = payload as { fullName: string; email: string; password: string; confirmPassword: string }
      return host.auth.register(body)
    }
    case IpcChannel.authLogin: {
      const body = payload as { email: string; password: string }
      const state = await host.auth.login(body)
      if (state.status === 'authenticated') {
        const restored = host.workspace.restore()
        if (restored) {
          host.onWorkspaceOpened?.(restored.path)
        }
      }
      return state
    }
    case IpcChannel.authVerify: {
      const body = payload as { email: string; code: string }
      const state = await host.auth.verifyEmail(body)
      if (state.status === 'authenticated') {
        const restored = host.workspace.restore()
        if (restored) {
          host.onWorkspaceOpened?.(restored.path)
        }
      }
      return state
    }
    case IpcChannel.authResend: {
      const body = payload as { email: string }
      return host.auth.resendVerification(body.email)
    }
    case IpcChannel.authForgot: {
      const body = payload as { email: string }
      return host.auth.forgotPassword(body.email)
    }
    case IpcChannel.authReset: {
      const body = payload as {
        email: string
        code: string
        password: string
        confirmPassword: string
      }
      return host.auth.resetPassword(body)
    }
    case IpcChannel.authLogout:
      return host.auth.logout()
    case IpcChannel.authLogoutAll:
      return host.auth.logoutAll()
    case IpcChannel.authMe:
      return host.auth.me()
    case IpcChannel.authDevices:
      return host.auth.listDevices()
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
      if (host.agent.isBusy()) {
        const active = host.database.activeAgentMission()
        const choice = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Keep working', 'Cancel mission and switch'],
          defaultId: 0,
          cancelId: 0,
          message: 'A mission is still running',
          detail:
            active
              ? `"${active.title}" is still running. KERN does not move running missions across projects. Cancel it to open another folder, or keep working in the current project.`
              : 'KERN does not move running missions across projects. Cancel the mission to open another folder, or keep working in the current project.'
        })
        if (choice.response !== 1) {
          return { canceled: true as const }
        }
        if (active) {
          host.agent.cancel(active.id)
          await host.agent.finished()
        }
      }
      const workspace = host.workspace.open(selected.filePaths[0]!)
      host.onWorkspaceOpened?.(workspace.path)
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
      withWatcherSuppress(host, () => host.workspace.write(path, content))
      return { saved: true as const }
    }
    case IpcChannel.workspaceCreateFile: {
      const { path, content } = payload as { path: string; content?: string }
      withWatcherSuppress(host, () => host.workspace.createFile(path, content))
      return { created: true as const }
    }
    case IpcChannel.workspaceCreateDirectory: {
      const { path } = payload as { path: string }
      withWatcherSuppress(host, () => host.workspace.createDirectory(path))
      return { created: true as const }
    }
    case IpcChannel.workspaceRename: {
      const { from, to, confirm } = payload as { from: string; to: string; confirm: true }
      withWatcherSuppress(host, () => host.workspace.rename(from, to, confirm))
      return { renamed: true as const }
    }
    case IpcChannel.workspaceRemove: {
      const { path, confirm } = payload as { path: string; confirm: true }
      withWatcherSuppress(host, () => host.workspace.remove(path, confirm))
      return { removed: true as const }
    }
    case IpcChannel.secretsStatus:
      return secretStatus(host.userData)
    case IpcChannel.secretsSet: {
      const { apiKey } = payload as { apiKey: string }
      await storeSecret(host.userData, apiKey)
      rememberConnection(host.database, 'bharatcode', 'credentials_stored')
      return { stored: true as const }
    }
    case IpcChannel.secretsClear:
      await clearSecret(host.userData)
      rememberConnection(host.database, 'bharatcode', 'not_configured')
      return { cleared: true as const }
    case IpcChannel.secretsSetCursor: {
      const { apiKey } = payload as { apiKey: string }
      await storeCursorSecret(host.userData, apiKey)
      rememberConnection(host.database, 'cursor', 'credentials_stored')
      return { stored: true as const }
    }
    case IpcChannel.secretsClearCursor:
      await clearCursorSecret(host.userData)
      rememberConnection(host.database, 'cursor', 'not_configured')
      return { cleared: true as const }
    case IpcChannel.providerGet:
      return currentProvider(host)
    case IpcChannel.providerSet: {
      const { provider } = payload as { provider: ProviderId }
      writeProviderId(host.database, provider)
      return currentProvider(host)
    }
    case IpcChannel.providerCheck:
      return checkSelectedProvider({
        database: host.database,
        configured: await configuredProviders(host.userData),
        readKey: (provider) => (provider === 'cursor' ? readCursorSecret(host.userData) : readSecret(host.userData)),
        probe: (provider, apiKey) => (provider === 'cursor' ? probeCursorAccount(apiKey) : probeBharatCode(apiKey))
      })
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
      const { limit, status, chatId } = payload as {
        limit?: number
        status?: 'open' | 'kept' | 'undone' | 'all'
        chatId?: string | null
      }
      return host.workspace.listFileChanges(limit, status ?? 'open', chatId)
    }
    case IpcChannel.historyKeepFileChanges: {
      const { ids } = payload as { ids?: string[] }
      return host.workspace.keepFileChanges(ids)
    }
    case IpcChannel.historyUndoFileChanges: {
      const { ids, confirm } = payload as { ids?: string[]; confirm: true }
      if (confirm !== true) {
        throw new PathJailError('Confirmation is required')
      }
      return host.workspace.undoFileChanges(ids)
    }
    case IpcChannel.historyFileChangeReview: {
      const { id } = payload as { id: string }
      return host.workspace.reviewFileChange(id)
    }
    case IpcChannel.agentSubmit: {
      const { prompt, continueFromMissionId, chatId } = payload as {
        prompt: string
        continueFromMissionId?: string
        chatId?: string
      }
      return host.agent.submit(prompt, continueFromMissionId, chatId)
    }
    case IpcChannel.agentCancel: {
      const { missionId } = payload as { missionId: string }
      return host.agent.cancel(missionId)
    }
    case IpcChannel.agentApprove: {
      const { missionId, operationId } = payload as { missionId: string; operationId: string }
      return host.agent.approve(missionId, operationId)
    }
    case IpcChannel.agentReject: {
      const { missionId, operationId } = payload as { missionId: string; operationId: string }
      return host.agent.reject(missionId, operationId)
    }
    case IpcChannel.agentRestore: {
      const { operationId } = payload as { operationId: string }
      return host.agent.restore(operationId)
    }
    case IpcChannel.agentCurrent:
      return host.agent.hydrate()
    case IpcChannel.agentHistory: {
      const { limit } = payload as { limit?: number }
      return host.agent.historyForWorkspace(limit)
    }
    case IpcChannel.agentTranscript: {
      const { missionId } = payload as { missionId: string }
      return host.agent.transcript(missionId)
    }
    case IpcChannel.chatList: {
      const { limit } = payload as { limit?: number }
      return host.agent.listChats(limit)
    }
    case IpcChannel.chatCreate:
      return host.agent.createChat()
    case IpcChannel.chatGet: {
      const { chatId } = payload as { chatId: string }
      return host.agent.chatTranscript(chatId)
    }
    case IpcChannel.chatSelect: {
      const { chatId } = payload as { chatId: string }
      return host.agent.selectChat(chatId)
    }
    case IpcChannel.chatRename: {
      const { chatId, title } = payload as { chatId: string; title: string }
      return host.agent.renameChat(chatId, title)
    }
    case IpcChannel.chatArchive: {
      const { chatId } = payload as { chatId: string }
      return host.agent.archiveChat(chatId)
    }
    case IpcChannel.chatHydrate:
      return host.agent.hydrateChat()
    case IpcChannel.metricsSubscribe: {
      const body = payload as { visible: boolean }
      host.metrics.subscribe(body)
      const pid = host.terminal.pid()
      if (pid) {
        host.metrics.trackTerminalPid(pid)
      }
      return { ok: true as const }
    }
    case IpcChannel.metricsUnsubscribe:
      host.metrics.unsubscribe()
      return { ok: true as const }
    case IpcChannel.gitStatus:
      return withGitWatcherQuiet(host, () => requireGit(host).status())
    case IpcChannel.gitDiff: {
      const git = requireGit(host)
      const body = payload as { path?: string; staged?: boolean }
      return withGitWatcherQuiet(host, () => git.diff(body))
    }
    case IpcChannel.gitLog: {
      const git = requireGit(host)
      const { limit } = payload as { limit?: number }
      return withGitWatcherQuiet(host, () => git.log(limit ?? 50))
    }
    case IpcChannel.gitInit: {
      const git = requireGit(host)
      await withGitWatcherQuiet(host, async () => {
        await git.init()
      })
      auditGit(host, 'git.init')
      return { initialized: true as const }
    }
    case IpcChannel.gitStage: {
      const git = requireGit(host)
      const { paths } = payload as { paths: 'all' | string[] }
      await withGitWatcherQuiet(host, async () => {
        if (paths === 'all') {
          await gitExecOk(git, ['add', '-A'], 'git add')
        } else {
          await git.stage(paths)
        }
      })
      auditGit(host, 'git.stage', { count: paths === 'all' ? 'all' : paths.length })
      return { staged: true as const }
    }
    case IpcChannel.gitUnstage: {
      const git = requireGit(host)
      const { paths } = payload as { paths: 'all' | string[] }
      await withGitWatcherQuiet(host, async () => {
        if (paths === 'all') {
          await gitExecOk(git, ['restore', '--staged', '.'], 'git restore')
        } else {
          await git.unstage(paths)
        }
      })
      auditGit(host, 'git.unstage', { count: paths === 'all' ? 'all' : paths.length })
      return { unstaged: true as const }
    }
    case IpcChannel.gitCommit: {
      const git = requireGit(host)
      const { message } = payload as { message: string }
      const hash = await withGitWatcherQuiet(host, () => git.commit(message))
      auditGit(host, 'git.commit', { hash })
      return { hash }
    }
    case IpcChannel.gitCreateBranch: {
      const git = requireGit(host)
      const { name } = payload as { name: string }
      await withGitWatcherQuiet(host, () => git.createBranch(name))
      auditGit(host, 'git.createBranch', { name })
      return { created: true as const }
    }
    case IpcChannel.gitSwitch: {
      const git = requireGit(host)
      const { name } = payload as { name: string }
      await withGitWatcherQuiet(host, () => git.switchBranch(name))
      auditGit(host, 'git.switch', { name })
      return { switched: true as const }
    }
    case IpcChannel.gitAddRemote: {
      const git = requireGit(host)
      const { name, url } = payload as { name: string; url: string }
      await withGitWatcherQuiet(host, () => git.addRemote(name, url))
      auditGit(host, 'git.addRemote', { name, url })
      return { added: true as const }
    }
    case IpcChannel.gitPush: {
      const git = requireGit(host)
      const body = payload as { remote?: string; branch?: string; setUpstream?: boolean }
      const result = await withGitWatcherQuiet(host, () => git.push(body), 5_000)
      auditGit(host, 'git.push', { remote: body.remote ?? 'origin', branch: body.branch })
      return result
    }
    case IpcChannel.gitPull: {
      const git = requireGit(host)
      const body = payload as { remote?: string; branch?: string }
      await withGitWatcherQuiet(host, () => git.pullFfOnly(body), 5_000)
      auditGit(host, 'git.pull', { remote: body.remote ?? 'origin', branch: body.branch })
      return { pulled: true as const }
    }
    case IpcChannel.gitIdentity:
      return withGitWatcherQuiet(host, () => requireGit(host).identity())
    case IpcChannel.gitSetIdentity: {
      const git = requireGit(host)
      const { name, email } = payload as { local: true; name: string; email: string }
      await withGitWatcherQuiet(host, () => git.setLocalIdentity(name, email))
      auditGit(host, 'git.setIdentity', { name, email })
      return { saved: true as const }
    }
    case IpcChannel.gitIgnorePreview: {
      const current = host.workspace.current()
      if (!current) {
        throw new PathJailError('No workspace is open')
      }
      const { stack: requestedStack } = payload as { stack?: 'node' | 'expo' | 'react-native' }
      const stack = requestedStack ?? detectProjectStack(current.path)
      const gitignorePath = path.join(current.path, '.gitignore')
      const exists = fs.existsSync(gitignorePath)
      return { content: generateGitignore(stack), stack, exists }
    }
    case IpcChannel.gitIgnoreWrite: {
      const current = host.workspace.current()
      if (!current) {
        throw new PathJailError('No workspace is open')
      }
      const { content } = payload as { content: string; confirm: true }
      withWatcherSuppress(host, () => host.workspace.write('.gitignore', content))
      auditGit(host, 'git.ignoreWrite')
      return { saved: true as const }
    }
    case IpcChannel.gitScanCommit: {
      const git = requireGit(host)
      const current = host.workspace.current()!
      const { paths: requestedPaths } = payload as { paths?: string[] }
      let paths = requestedPaths
      if (!paths) {
        const status = await git.status()
        paths = status.entries
          .filter((entry) => entry.status !== 'ignored' && entry.status !== 'unmodified')
          .map((entry) => entry.path)
      }
      return findRiskyCommitPaths(current.path, paths, (absolute) => {
        try {
          return fs.statSync(absolute)
        } catch {
          return null
        }
      })
    }
    case IpcChannel.gitExportPreview: {
      const git = requireGit(host)
      const { includeGit } = payload as { includeGit?: boolean }
      return listExportPaths(git, { includeGit })
    }
    case IpcChannel.gitExport: {
      const git = requireGit(host)
      const { includeGit, destination } = payload as { includeGit?: boolean; destination?: string }
      let dest = destination?.trim()
      if (!dest) {
        if (!win) {
          throw new Error('Request failed')
        }
        const save = await dialog.showSaveDialog(win, {
          title: 'Export project',
          defaultPath: 'kern-project-export.zip',
          filters: [{ name: 'Zip archive', extensions: ['zip'] }]
        })
        if (save.canceled || !save.filePath) {
          throw new Error('Export canceled')
        }
        dest = save.filePath
      }
      const preview = await listExportPaths(git, { includeGit })
      const written = await writeExportZip(git.workspace(), preview.paths, dest)
      auditGit(host, 'git.export', { destination: dest, fileCount: written.fileCount, bytes: written.bytes })
      return written
    }
    case IpcChannel.gitPublishProbe: {
      const current = host.workspace.current()
      if (!current) {
        throw new PathJailError('No workspace is open')
      }
      return withGitWatcherQuiet(host, async () => {
        const git = new GitService(current.path)
        const isRepo = await git.isRepository()
        let hasCommits = false
        let identity = { name: null as string | null, email: null as string | null, configured: false }
        let remotes: Awaited<ReturnType<GitService['remotes']>> = []
        if (isRepo) {
          const head = await git.exec(['rev-parse', '--verify', 'HEAD'])
          hasCommits = head.exitCode === 0
          identity = await git.identity()
          remotes = await git.remotes()
        }
        const gitignoreExists = fs.existsSync(path.join(current.path, '.gitignore'))
        const ghAvailable = await ghCliAvailable()
        return { isRepo, hasCommits, identity, remotes, gitignoreExists, ghAvailable }
      })
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

