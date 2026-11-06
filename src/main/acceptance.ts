import fs from 'node:fs'
import type { BrowserWindow } from 'electron'
import { isAlive } from './services/processGroup.mjs'
import type { TerminalService } from './services/terminal.ts'

const PAGE_SCRIPT = `async () => {
  const phase = ${JSON.stringify('')}
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (predicate, label) => {
    const started = Date.now()
    while (Date.now() - started < 15000) {
      if (predicate()) return
      await sleep(50)
    }
    throw new Error('Timed out waiting for ' + label)
  }
  const kern = window.kern
  const secret = window.__kernAcceptanceSecret || ''
  delete window.__kernAcceptanceSecret
  const report = { phase: document.documentElement.dataset.acceptancePhase || '' }
  if (!kern || typeof kern.workspace.read !== 'function') {
    throw new Error('Preload bridge is missing')
  }
  const bridgeKeys = JSON.stringify(Object.keys(kern))
  report.bridgeClean = !bridgeKeys.includes('exec') && typeof kern.terminal.write === 'function' && kern.secrets.get === undefined
  const invalid = await kern.workspace.read({ path: 12, extra: true })
  report.invalidRejected = invalid.ok === false && invalid.error === 'Invalid request' && !JSON.stringify(invalid).includes(secret)
  const traversal = await kern.workspace.read({ path: '../outside.txt' })
  report.traversalRejected = traversal.ok === false
  const absolute = await kern.workspace.read({ path: '/etc/passwd' })
  report.absoluteRejected = absolute.ok === false
  const symlink = await kern.workspace.read({ path: 'escape-link/secret.txt' })
  report.symlinkRejected = symlink.ok === false
  const current = await kern.workspace.current({})
  report.workspaceOpen = Boolean(current.ok && current.data && current.data.path)
  if (report.phase === 'verify') {
    const read = await kern.workspace.read({ path: 'kern-phase1.txt' })
    report.persistedText = Boolean(read.ok && read.data && read.data.content === 'version-2\\n')
    const changes = await kern.history.fileChanges({ limit: 20 })
    report.historyKept = Boolean(changes.ok && Array.isArray(changes.data) && changes.data.some((row) => row.relativePath === 'kern-phase1.txt'))
    const missions = await kern.history.missions({ limit: 20 })
    report.missionsKept = Boolean(missions.ok && Array.isArray(missions.data) && missions.data.length > 0)
    const status = await kern.secrets.status({})
    report.secretStillStored = Boolean(status.ok && status.data && status.data.configured === true)
    report.secretAbsentFromDom = !document.body.innerText.includes(secret)
    report.secretAbsentFromBridge = !JSON.stringify(status).includes(secret)
    return report
  }
  const created = await kern.workspace.createFile({ path: 'kern-phase1.txt', content: 'version-1\\n' })
  report.created = created.ok === true
  document.querySelector('[data-action="refresh"]').click()
  await waitFor(() => document.querySelector('[data-path="kern-phase1.txt"]'), 'file row')
  document.querySelector('[data-path="kern-phase1.txt"]').click()
  await waitFor(() => document.querySelector('.monaco-editor'), 'monaco')
  await waitFor(() => window.__kernEditors && window.__kernEditors().length > 0, 'editor instance')
  window.__kernEditors()[0].setValue('version-2\\n')
  document.querySelector('[data-action="save"]').click()
  await sleep(200)
  const saved = await kern.workspace.read({ path: 'kern-phase1.txt' })
  report.editedInMonaco = Boolean(saved.ok && saved.data && saved.data.content === 'version-2\\n')
  const input = document.querySelector('[data-secret-input]')
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  valueSetter.call(input, secret)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(() => document.querySelector('[data-action="secret-save"]').disabled === false, 'secret button')
  document.querySelector('[data-action="secret-save"]').click()
  await waitFor(() => document.querySelector('[data-secret-status]')?.textContent === 'Key stored', 'secret status')
  report.secretStored = true
  report.secretInputCleared = input.value === ''
  report.secretAbsentFromDom = !document.body.innerText.includes(secret)
  await waitFor(() => document.querySelector('.xterm'), 'terminal')
  let output = ''
  const dataId = kern.terminal.onData((chunk) => { output += chunk })
  const enter = String.fromCharCode(10)
  const commandStarted = Date.now()
  while (!output.includes('kern-terminal-ok') && Date.now() - commandStarted < 15000) {
    await kern.terminal.write({ data: "printf 'kern-terminal-ok\\\\n'" + enter })
    await sleep(250)
  }
  if (!output.includes('kern-terminal-ok')) {
    throw new Error('Timed out waiting for terminal output')
  }
  report.terminalStreamed = true
  await kern.terminal.write({ data: 'sleep 120 & echo KERN_CHILD:$!' + enter })
  await waitFor(() => /KERN_CHILD:\\d+/.test(output), 'child pid')
  const childPid = Number(output.match(/KERN_CHILD:(\\d+)/)[1])
  report.childPid = childPid
  document.querySelector('[data-action="terminal-cancel"]').click()
  await sleep(400)
  kern.terminal.offData(dataId)
  report.cancelRequested = true
  return report
}`

export async function runAcceptance(win: BrowserWindow, terminal: TerminalService): Promise<void> {
  const reportPath = process.env.KERN_ACCEPTANCE_REPORT
  const phase = process.env.KERN_ACCEPTANCE
  if (!reportPath || (phase !== '1' && phase !== 'verify')) {
    return
  }
  const secret = process.env.KERN_ACCEPTANCE_SECRET ?? ''
  let report: Record<string, unknown> = { phase, ok: false }
  try {
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.acceptancePhase = ${JSON.stringify(phase)}; window.__kernAcceptanceSecret = ${JSON.stringify(secret)};`,
      true
    )
    const script = PAGE_SCRIPT.replace('const phase = ""', `const phase = ${JSON.stringify(phase)}`)
    const page = (await win.webContents.executeJavaScript(`(${script})()`, true)) as Record<string, unknown>
    const childPid = typeof page.childPid === 'number' ? page.childPid : 0
    if (phase === '1') {
      if (childPid > 0) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        page.childStopped = !isAlive(childPid)
      } else {
        page.childStopped = false
      }
      page.terminalStopped = terminal.pid() === null
    }
    delete page.childPid
    const serialized = JSON.stringify(page)
    if (secret && serialized.includes(secret)) {
      report = { phase, ok: false, error: 'Acceptance report contained the API key' }
    } else {
      const checks = Object.entries(page).filter(([, value]) => typeof value === 'boolean')
      const ok = checks.every(([, value]) => value === true)
      report = { ...page, ok }
    }
  } catch (error) {
    report = {
      phase,
      ok: false,
      error: error instanceof Error ? error.message : 'Acceptance failed'
    }
  }
  const serialized = JSON.stringify(report)
  if (secret && serialized.includes(secret)) {
    fs.writeFileSync(reportPath, JSON.stringify({ phase, ok: false, error: 'Acceptance report contained the API key' }))
  } else {
    fs.writeFileSync(reportPath, serialized)
  }
  const { app } = await import('electron')
  app.exit(report.ok === true ? 0 : 1)
}
