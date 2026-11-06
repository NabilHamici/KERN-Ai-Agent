import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-accept-data-'))
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-accept-work-'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-accept-out-'))
const secret = `bc_live_${crypto.randomBytes(18).toString('hex')}`

fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside')
fs.symlinkSync(outside, path.join(workspace, 'escape-link'))
fs.writeFileSync(path.join(workspace, 'README.txt'), 'hello\n')

function run(phase, reportName) {
  const report = path.join(userData, reportName)
  return new Promise((resolve) => {
    const child = spawn(electron, ['.'], {
      cwd: root,
      env: {
        ...process.env,
        KERN_ACCEPTANCE: phase,
        KERN_ACCEPTANCE_WORKSPACE: workspace,
        KERN_USER_DATA: userData,
        KERN_ACCEPTANCE_REPORT: report,
        KERN_ACCEPTANCE_SECRET: secret
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 90000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const body = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : ''
      resolve({ code, report: body, stdout, stderr })
    })
  })
}

const first = await run('1', 'phase1.json')
const second = await run('verify', 'verify.json')
const secretFile = path.join(userData, 'api-key.bin')
const secretBytes = fs.existsSync(secretFile) ? fs.readFileSync(secretFile) : Buffer.alloc(0)
const db = new DatabaseSync(path.join(userData, 'kern.sqlite'))
const fileRow = db.prepare('SELECT relative_path, change_type FROM file_changes WHERE relative_path = ?').get('kern-phase1.txt')
const missionCount = db.prepare('SELECT COUNT(*) AS count FROM missions').get()
db.close()
const saved = fs.readFileSync(path.join(workspace, 'kern-phase1.txt'), 'utf8')

const summary = {
  firstExit: first.code,
  secondExit: second.code,
  firstReport: first.report ? JSON.parse(first.report) : null,
  secondReport: second.report ? JSON.parse(second.report) : null,
  savedText: saved,
  secretFileContainsPlaintext: secretBytes.includes(Buffer.from(secret)),
  sqliteFileChange: fileRow ?? null,
  missionCount: missionCount?.count ?? 0,
  firstStderr: first.stderr.slice(0, 2000),
  secondStderr: second.stderr.slice(0, 2000)
}

const ok =
  summary.firstExit === 0 &&
  summary.secondExit === 0 &&
  summary.firstReport?.ok === true &&
  summary.secondReport?.ok === true &&
  summary.savedText === 'version-2\n' &&
  summary.secretFileContainsPlaintext === false &&
  summary.sqliteFileChange?.relative_path === 'kern-phase1.txt' &&
  summary.missionCount > 0 &&
  !JSON.stringify(summary.firstReport).includes(secret) &&
  !JSON.stringify(summary.secondReport).includes(secret)

console.log(JSON.stringify(summary, null, 2))
if (!ok) {
  process.exit(1)
}
