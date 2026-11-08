import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_LIMITS } from '../../shared/agent.ts'
import { PathJailError, normalizeRelative, resolveInside } from '../security/pathJail.ts'
import type { MissionDatabase } from '../services/database.ts'
import { runCapturedCommand } from '../services/commandProcess.ts'
import type { ToolExecution } from './tools.ts'

const ALLOWED_COMMANDS = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'corepack',
  'node',
  'deno',
  'tsc',
  'eslint',
  'prettier',
  'expo',
  'eas',
  'python',
  'python3',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'flutter',
  'dart',
  'cargo',
  'rustc',
  'go',
  'ruby',
  'gem',
  'bundle',
  'php',
  'composer',
  'java',
  'javac',
  'mvn',
  'gradle',
  'dotnet',
  'make',
  'cmake'
])

const BLOCKED_COMMANDS = new Set([
  'git',
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'dd',
  'mkfs',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'sudo',
  'su',
  'doas',
  'chmod',
  'chown',
  'chgrp',
  'kill',
  'pkill',
  'killall',
  'launchctl',
  'diskutil',
  'csrutil',
  'nvram',
  'bash',
  'sh',
  'zsh',
  'dash',
  'fish',
  'cmd',
  'powershell',
  'pwsh',
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'osascript',
  'open'
])

const EVAL_FLAGS = new Set(['-e', '--eval', '-c', '--command'])
const EVAL_COMMANDS = new Set(['node', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl', 'php'])

const runningRoots = new Set<string>()

type CommandRequest = {
  command: string
  args: string[]
  workingDirectory: string
  explanation: string
  timeoutMs: number
}

export function commandPreview(argumentsText: string): { command: string; args: string[]; workingDirectory: string } {
  try {
    const parsed = JSON.parse(argumentsText) as {
      command?: unknown
      executable?: unknown
      args?: unknown
      working_directory?: unknown
      workingDirectory?: unknown
    }
    const args = Array.isArray(parsed.args) ? parsed.args.filter((item) => typeof item === 'string') : []
    const cwd =
      typeof parsed.working_directory === 'string' && parsed.working_directory.trim()
        ? parsed.working_directory
        : typeof parsed.workingDirectory === 'string' && parsed.workingDirectory.trim()
          ? parsed.workingDirectory
          : '.'
    const command =
      typeof parsed.command === 'string' && parsed.command.trim()
        ? parsed.command
        : typeof parsed.executable === 'string' && parsed.executable.trim()
          ? parsed.executable
          : 'command'
    return {
      command,
      args: args as string[],
      workingDirectory: cwd
    }
  } catch {
    return { command: 'command', args: [], workingDirectory: '.' }
  }
}

export async function runBrokerCommand(input: {
  root: string
  database: MissionDatabase
  missionId: string
  callId: string
  argumentsText: string
  signal: AbortSignal
  onSpawn?: (pid: number) => void
  onFinished?: (cwdRelative: string) => void
}): Promise<ToolExecution> {
  let request: CommandRequest
  try {
    request = parseRequest(input.argumentsText)
  } catch (error) {
    return rejected(error instanceof Error ? error.message : 'Command arguments were rejected.')
  }

  let cwd = input.root
  let relativeCwd = '.'
  try {
    relativeCwd = normalizeRelative(request.workingDirectory)
    cwd = resolveInside(input.root, relativeCwd)
    const stat = fs.statSync(cwd)
    if (!stat.isDirectory()) {
      return rejected('Working directory is not a directory.')
    }
  } catch (error) {
    return rejected(error instanceof PathJailError ? error.message : 'Working directory is outside the workspace.')
  }

  const policy = policyDecision(request.command, request.args)
  if (!policy.ok) {
    const id = crypto.randomUUID()
    input.database.createAgentCommand({
      id,
      missionId: input.missionId,
      callId: input.callId,
      command: request.command,
      args: request.args,
      workingDirectory: relativeCwd,
      explanation: request.explanation,
      status: 'failed'
    })
    input.database.updateAgentCommand(id, {
      status: 'failed',
      error: policy.error,
      finishedAt: new Date().toISOString()
    })
    return rejected(policy.error)
  }

  for (const arg of request.args) {
    if (argumentEscapes(input.root, arg)) {
      return rejected('Command arguments must stay inside the workspace.')
    }
  }

  let executable: string
  try {
    executable = resolveExecutable(input.root, request.command)
  } catch (error) {
    return rejected(error instanceof Error ? error.message : 'Command is not available.')
  }

  const rootKey = fs.realpathSync(input.root)
  if (runningRoots.has(rootKey)) {
    return rejected('A command is already running in this workspace.')
  }
  runningRoots.add(rootKey)

  const id = crypto.randomUUID()
  input.database.createAgentCommand({
    id,
    missionId: input.missionId,
    callId: input.callId,
    command: request.command,
    args: request.args,
    workingDirectory: relativeCwd,
    explanation: request.explanation,
    status: 'queued'
  })

  const startedAt = new Date().toISOString()
  input.database.updateAgentCommand(id, { status: 'running', startedAt })

  try {
    const result = await runCapturedCommand({
      executable,
      args: request.args,
      cwd,
      timeoutMs: request.timeoutMs,
      signal: input.signal,
      onSpawn: input.onSpawn
    })
    input.onFinished?.(relativeCwd)
    input.database.updateAgentCommand(id, {
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
      finishedAt: new Date().toISOString()
    })
    const warnings = commandWarnings(result.exitCode, result.stderr, result.stdout)
    const resolvedRoot = resolveInside(input.root, '.')
    const payload = {
      ok: result.status === 'completed',
      outcome: result.status === 'completed' ? 'success' : result.status === 'cancelled' ? 'cancelled' : 'failed',
      status: result.status,
      command: request.command,
      args: request.args,
      workingDirectory: relativeCwd,
      cwd: cwd,
      workspaceRoot: resolvedRoot,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      durationMs: result.durationMs,
      warnings,
      error: result.error,
      note:
        warnings.length > 0
          ? 'Exit code alone is not enough. Read stderr/warnings before claiming install or scaffold success.'
          : undefined
    }
    const state: ToolExecution['state'] =
      result.status === 'completed' ? 'success' : result.status === 'cancelled' ? 'cancelled' : 'failed'
    return { state, output: JSON.stringify(payload) }
  } finally {
    runningRoots.delete(rootKey)
  }
}

function parseRequest(argumentsText: string): CommandRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  } catch {
    throw new Error('Command arguments were not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Command arguments were rejected.')
  }
  const record = parsed as Record<string, unknown>
  const allowed = new Set([
    'command',
    'executable',
    'args',
    'working_directory',
    'workingDirectory',
    'explanation',
    'timeout_ms'
  ])
  const example =
    '{"command":"pnpm","args":["exec","tsc","--noEmit"],"working_directory":".","explanation":"Typecheck"}'
  const hint =
    'Put the program in `command` and each argument in `args`, e.g. {"command":"pnpm","args":["exec","tsc","--noEmit"]}'
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Tool arguments were rejected. ${key}: unrecognized key. Expected fields: command|executable, args, working_directory|workingDirectory, explanation (optional), timeout_ms. ${hint} Example: ${example}`
      )
    }
  }
  const commandValue =
    typeof record.command === 'string' && record.command.trim()
      ? record.command
      : typeof record.executable === 'string' && record.executable.trim()
        ? record.executable
        : null
  if (!commandValue || commandValue.length > 256) {
    throw new Error(`Tool arguments were rejected. command is required. ${hint}`)
  }
  const args = Array.isArray(record.args) ? record.args : []
  if (!Array.isArray(record.args) || args.length > 40 || args.some((item) => typeof item !== 'string' || item.length > 2_000)) {
    throw new Error(`Tool arguments were rejected. args must be an array of strings. ${hint}`)
  }
  if (/\s/.test(commandValue.trim()) && args.length === 0) {
    throw new Error(`Tool arguments were rejected. ${hint}`)
  }
  if (record.explanation !== undefined && (typeof record.explanation !== 'string' || record.explanation.length > 500)) {
    throw new Error(`Tool arguments were rejected. explanation must be a short string when provided. Example: ${example}`)
  }
  const timeout =
    record.timeout_ms === undefined ? AGENT_LIMITS.defaultCommandTimeoutMs : record.timeout_ms
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1_000 || timeout > AGENT_LIMITS.maxCommandTimeoutMs) {
    throw new Error(
      `Tool arguments were rejected. timeout_ms must be an integer between 1000 and ${AGENT_LIMITS.maxCommandTimeoutMs}. Example: ${example}`
    )
  }
  const workingDirectory =
    record.working_directory !== undefined
      ? record.working_directory
      : record.workingDirectory !== undefined
        ? record.workingDirectory
        : '.'
  if (typeof workingDirectory !== 'string' || workingDirectory.length > 4096) {
    throw new Error(`Tool arguments were rejected. working_directory is invalid. Example: ${example}`)
  }
  const command = commandValue.trim()
  const explanation =
    typeof record.explanation === 'string' && record.explanation.trim()
      ? record.explanation.trim()
      : `Run ${command}`
  return {
    command,
    args: args as string[],
    workingDirectory,
    explanation,
    timeoutMs: timeout
  }
}

function policyDecision(command: string, args: string[]): { ok: true } | { ok: false; error: string } {
  if (command.includes('\0') || /[\s]/.test(command)) {
    return { ok: false, error: 'The command must be an executable name or a workspace-relative path, not a shell string.' }
  }
  const base = path.posix.basename(command.replaceAll('\\', '/'))
  if (BLOCKED_COMMANDS.has(base)) {
    return {
      ok: false,
      error:
        base === 'git'
          ? 'Git commit, push, remote, branch, and history commands are unavailable.'
          : `The command ${base} is blocked.`
    }
  }
  const relative = command.includes('/') || command.includes('\\') || command.startsWith('.')
  if (!relative && !ALLOWED_COMMANDS.has(base)) {
    return { ok: false, error: `The command ${base} is not an allowed development tool.` }
  }
  if (EVAL_COMMANDS.has(base) && args.some((arg) => EVAL_FLAGS.has(arg))) {
    return { ok: false, error: 'Inline interpreter evaluation is blocked. Run a script file inside the workspace.' }
  }
  return { ok: true }
}

function resolveExecutable(root: string, command: string): string {
  const relative = command.includes('/') || command.includes('\\') || command.startsWith('.')
  if (relative) {
    if (path.isAbsolute(command) || path.posix.isAbsolute(command) || path.win32.isAbsolute(command)) {
      throw new Error('Absolute command paths are blocked.')
    }
    const resolved = resolveInside(root, command)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error('Workspace command was not found.')
    }
    return resolved
  }
  const pathEnv = process.env.PATH || '/usr/bin:/bin:/usr/local/bin'
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) {
      continue
    }
    const candidate = path.join(directory, command)
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate
      }
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`The command ${command} was not found on PATH.`)
}

function argumentEscapes(root: string, arg: string): boolean {
  if (arg.includes('\0')) {
    return true
  }
  if (arg === '..' || arg.startsWith('../') || arg.includes('/../') || arg.endsWith('/..') || arg.includes('\\..\\') || arg.startsWith('..\\')) {
    return true
  }
  if (!(path.isAbsolute(arg) || path.posix.isAbsolute(arg) || path.win32.isAbsolute(arg))) {
    return false
  }
  const rootReal = fs.realpathSync(root)
  let candidate = path.resolve(arg)
  try {
    candidate = fs.realpathSync(candidate)
  } catch {
    // The absolute path does not exist yet. Compare its lexical location.
  }
  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`
  return candidate !== rootReal && !candidate.startsWith(prefix)
}

function rejected(error: string): ToolExecution {
  return { state: 'rejected', output: JSON.stringify({ ok: false, outcome: 'rejected', error }) }
}

function commandWarnings(exitCode: number | null, stderr: string, stdout: string): string[] {
  const text = `${stderr}\n${stdout}`
  const warnings: string[] = []
  if (/ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network read|fetch failed|certificate|proxy/i.test(text)) {
    warnings.push('Network/registry error text appears in command output.')
  }
  if (exitCode === 0 && /npm error|ERR!|failed/i.test(stderr)) {
    warnings.push('Command exited 0 but stderr reports an error. Treat dependency install as unverified.')
  }
  return warnings
}
