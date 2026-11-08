import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_LIMITS } from '../../shared/agent.ts'
import { isAlive, killProcessGroup } from './processGroup.mjs'

const OUTPUT_HARD_CAP = 200_000

const PASS_THROUGH_EXACT = new Set([
  'PATH',
  'Path',
  'HOME',
  'USER',
  'USERPROFILE',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'npm_config_registry',
  'npm_config_user_agent',
  'npm_config_cache',
  'npm_config_prefix',
  'NODE_OPTIONS'
])

const PASS_THROUGH_PREFIX = ['npm_config_', 'NPM_CONFIG_', 'PNPM_', 'YARN_', 'COREPACK_']
const SECRET_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|API[_-]?KEY)/i

export type CapturedCommand = {
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
  exitCode: number | null
  stdout: string
  stderr: string
  error: string | null
  truncated: boolean
  durationMs: number
}

export function runCapturedCommand(input: {
  executable: string
  args: string[]
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  onSpawn?: (pid: number) => void
}): Promise<CapturedCommand> {
  return new Promise((resolve) => {
    const stdout: string[] = []
    const stderr: string[] = []
    let collected = 0
    let truncated = false
    let settled = false
    let timedOut = false
    let cancelled = false
    const started = Date.now()
    const env = commandEnvironment()

    const finish = (result: {
      status: CapturedCommand['status']
      exitCode: number | null
      error: string | null
    }): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
      resolve({
        ...result,
        stdout: bound(stdout.join('')),
        stderr: bound(stderr.join('')),
        truncated,
        durationMs: Date.now() - started
      })
    }

    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    if (child.pid) {
      input.onSpawn?.(child.pid)
    }

    const killChild = (): void => {
      if (child.pid && isAlive(child.pid)) {
        try {
          killProcessGroup(child.pid)
        } catch {
          // The process already exited.
        }
      }
    }

    const onAbort = (): void => {
      cancelled = true
      killChild()
    }
    if (input.signal.aborted) {
      onAbort()
    } else {
      input.signal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killChild()
    }, input.timeoutMs)

    const consume = (target: string[], chunk: Buffer): void => {
      collected += chunk.length
      if (collected > OUTPUT_HARD_CAP) {
        truncated = true
        killChild()
        return
      }
      target.push(chunk.toString('utf8'))
      if (target.join('').length > AGENT_LIMITS.maxCommandOutputChars) {
        truncated = true
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => consume(stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer) => consume(stderr, chunk))
    child.on('error', (error) => {
      finish({ status: 'failed', exitCode: null, error: error.message || 'The command could not be started.' })
    })
    child.on('close', (code) => {
      if (cancelled || input.signal.aborted) {
        finish({ status: 'cancelled', exitCode: code, error: 'The command was cancelled.' })
        return
      }
      if (timedOut) {
        finish({ status: 'timed_out', exitCode: code, error: 'The command timed out.' })
        return
      }
      if (code === 0) {
        finish({ status: 'completed', exitCode: 0, error: null })
        return
      }
      finish({ status: 'failed', exitCode: code, error: `Command exited with code ${code ?? 'unknown'}.` })
    })
  })
}

export function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin',
    HOME: process.env.HOME || process.env.USERPROFILE || os.homedir(),
    USER: process.env.USER || process.env.USERNAME,
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    TEMP: process.env.TEMP || process.env.TMPDIR || os.tmpdir(),
    TMP: process.env.TMP || process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    EXPO_NO_TELEMETRY: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_yes: 'true'
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue
    }
    if (SECRET_ENV.test(key) && !PASS_THROUGH_EXACT.has(key) && !PASS_THROUGH_PREFIX.some((prefix) => key.startsWith(prefix))) {
      continue
    }
    if (PASS_THROUGH_EXACT.has(key) || PASS_THROUGH_PREFIX.some((prefix) => key.startsWith(prefix))) {
      env[key] = value
    }
  }
  // Never inherit application API keys into child processes.
  delete env.BHARATCODE_API_KEY
  delete env.CURSOR_API_KEY
  delete env.OPENAI_API_KEY
  delete env.ANTHROPIC_API_KEY
  return env
}

function bound(value: string): string {
  const max = AGENT_LIMITS.maxCommandOutputChars
  if (value.length <= max) {
    return value
  }
  const head = Math.floor(max * 0.65)
  const tail = Math.max(200, max - head - 48)
  const omitted = value.length - head - tail
  return `${value.slice(0, head)}\n...[truncated ${omitted} chars]...\n${value.slice(-tail)}`
}
