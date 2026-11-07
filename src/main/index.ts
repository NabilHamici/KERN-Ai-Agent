import { app, BrowserWindow, session } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc.ts'
import { createProductionClient } from './agent/client.ts'
import { createCursorSdkBridge, cursorUsesStoredLogin } from './agent/cursorSdk.ts'
import { readProviderId } from './agent/providerSettings.ts'
import { AgentRuntime } from './agent/runtime.ts'
import { IpcChannel } from '../shared/ipc.ts'
import { MissionDatabase } from './services/database.ts'
import { readSecret } from './services/secrets.ts'
import { TerminalService } from './services/terminal.ts'
import { WorkspaceService } from './services/workspace.ts'
import { runAcceptance } from './acceptance.ts'

const acceptancePhase = process.env.KERN_ACCEPTANCE
const acceptance = acceptancePhase === '1' || acceptancePhase === 'verify'

if (acceptance && process.env.KERN_USER_DATA) {
  app.setPath('userData', process.env.KERN_USER_DATA)
}

let mainWindow: BrowserWindow | null = null
let database: MissionDatabase | null = null
let terminal: TerminalService | null = null
let agent: AgentRuntime | null = null

function contentSecurityPolicy(): string {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    const origin = new URL(rendererUrl).origin
    // The dev server injects Vite's React refresh preamble as an inline module.
    // Production bundles have no inline scripts, so script-src stays 'self' there.
    return [
      `default-src 'self' ${origin}`,
      `script-src 'self' 'unsafe-inline' ${origin}`,
      `style-src 'self' 'unsafe-inline' ${origin}`,
      `worker-src 'self' blob: ${origin}`,
      `connect-src 'self' ${origin} ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*`,
      `img-src 'self' data: blob: ${origin}`,
      `font-src 'self' data:`
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'"
  ].join('; ')
}

function installSessionGuards(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders }
    if (details.resourceType === 'mainFrame') {
      responseHeaders['Content-Security-Policy'] = [contentSecurityPolicy()]
    }
    callback({ responseHeaders })
  })
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'KERN',
    backgroundColor: '#0D0E11',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    const url = new URL(rendererUrl)
    if (acceptance) {
      url.searchParams.set('acceptance', '1')
    }
    await mainWindow.loadURL(url.toString())
  } else {
    const html = path.join(__dirname, '../renderer/index.html')
    if (acceptance) {
      await mainWindow.loadFile(html, { query: { acceptance: '1' } })
    } else {
      await mainWindow.loadFile(html)
    }
  }
}

void app.whenReady().then(async () => {
  installSessionGuards()
  const dbPath = path.join(app.getPath('userData'), 'kern.sqlite')
  const db = new MissionDatabase(dbPath)
  database = db
  const workspace = new WorkspaceService(db)
  terminal = new TerminalService()
  const userData = app.getPath('userData')
  const runtime = new AgentRuntime({
    database: db,
    currentWorkspace: () => workspace.current(),
    readApiKey: () => readSecret(userData),
    cursorReady: () => cursorUsesStoredLogin(),
    readProvider: () => readProviderId(db),
    client: createProductionClient({
      database: db,
      readProvider: () => readProviderId(db),
      readKey: (provider) => (provider === 'cursor' ? Promise.resolve(null) : readSecret(userData)),
      cursor: createCursorSdkBridge(path.join(userData, 'cursor-runtime'))
    }),
    emit: (event) => {
      mainWindow?.webContents.send(IpcChannel.agentEvent, event)
    }
  })
  agent = runtime
  if (acceptance && process.env.KERN_ACCEPTANCE_WORKSPACE) {
    workspace.open(process.env.KERN_ACCEPTANCE_WORKSPACE)
  } else {
    workspace.restore()
  }
  registerIpc({
    getWindow: () => mainWindow,
    workspace,
    terminal,
    agent: runtime,
    database: db,
    userData: app.getPath('userData')
  })
  await createWindow()
  if (acceptance && mainWindow) {
    await runAcceptance(mainWindow, terminal)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow()
    }
  })
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.name : 'startup failure'
  console.error(`KERN failed to start: ${message}`)
  app.exit(1)
})

app.on('before-quit', () => {
  agent?.stopAll()
  terminal?.cancel()
  database?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || acceptance) {
    app.quit()
  }
})
