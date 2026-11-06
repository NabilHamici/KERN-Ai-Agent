const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-electron-'))
app.setPath('userData', userData)

function fail(message) {
  fs.writeFileSync(path.join(userData, 'runtime-result.json'), JSON.stringify({ ok: false, error: message }))
  console.error(message)
  app.exit(1)
}

app.whenReady().then(async () => {
  const result = { ok: true, sqlite: false, safeStorage: false, pty: false }
  try {
    const sqlite = require('node:sqlite')
    const DatabaseSync = sqlite.DatabaseSync
    if (typeof DatabaseSync !== 'function') {
      fail('node:sqlite DatabaseSync is missing in Electron')
      return
    }
    const dbPath = path.join(userData, 'smoke.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE missions (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
    db.prepare('INSERT INTO missions (id, title) VALUES (?, ?)').run('m1', 'phase-1')
    db.close()
    const reopened = new DatabaseSync(dbPath)
    const row = reopened.prepare('SELECT title FROM missions WHERE id = ?').get('m1')
    reopened.close()
    if (!row || row.title !== 'phase-1') {
      fail('SQLite did not round-trip inside Electron')
      return
    }
    result.sqlite = true

    if (
      typeof safeStorage.isAsyncEncryptionAvailable !== 'function' ||
      typeof safeStorage.encryptStringAsync !== 'function' ||
      typeof safeStorage.decryptStringAsync !== 'function'
    ) {
      fail('Electron async safeStorage API is missing')
      return
    }
    const available = await safeStorage.isAsyncEncryptionAvailable()
    if (!available) {
      fail('Electron safeStorage is unavailable on this Mac')
      return
    }
    const secret = `bc_live_${crypto.randomBytes(24).toString('hex')}`
    const encrypted = Buffer.from(await safeStorage.encryptStringAsync(secret))
    if (encrypted.includes(Buffer.from(secret))) {
      fail('safeStorage ciphertext contained the plaintext key')
      return
    }
    const decrypted = await safeStorage.decryptStringAsync(encrypted)
    if (!decrypted || decrypted.result !== secret) {
      fail('safeStorage decrypt did not match')
      return
    }
    result.safeStorage = true

    const pty = require('node-pty')
    const { killProcessGroup, isAlive } = await import('../src/main/services/processGroup.mjs')
    const term = pty.spawn('/bin/sh', [], {
      name: 'xterm-256color',
      cwd: userData,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color' },
      cols: 80,
      rows: 24
    })
    let streamed = ''
    term.onData((chunk) => {
      streamed += chunk
    })
    const sleepPid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`PTY did not print a child pid: ${JSON.stringify(streamed)}`)), 8000)
      term.onData((chunk) => {
        streamed += chunk
        const match = streamed.match(/KERN_CHILD:(\d+)/)
        if (match) {
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
      })
      term.write("sleep 120 &\necho KERN_CHILD:$!\n")
    })
    term.write("printf 'kern-terminal-ok\\n'\n")
    await new Promise((resolve) => setTimeout(resolve, 300))
    killProcessGroup(term.pid)
    try {
      term.kill()
    } catch {
      // already dead
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (isAlive(sleepPid) || isAlive(term.pid)) {
      fail(`PTY child survived cancellation sleep=${sleepPid} pty=${term.pid}`)
      return
    }
    result.pty = true
    result.streamSample = streamed.includes('kern-terminal-ok')
    fs.writeFileSync(path.join(userData, 'runtime-result.json'), JSON.stringify(result))
    console.log(JSON.stringify(result))
    app.exit(result.streamSample ? 0 : 1)
  } catch (error) {
    fail(error instanceof Error ? error.stack ?? error.message : String(error))
  }
})
