import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { AGENT_LIMITS } from '../../shared/agent.ts'
import {
  maskRemoteUrl,
  parseGitLog,
  parseGitRemotes,
  parsePorcelainV2Z,
  validateRemoteUrl,
  type GitIdentityResult,
  type GitLogEntry,
  type GitStatusResult
} from '../../shared/git.ts'
import { PathJailError, normalizeRelative, resolveInside, workspaceRoot } from '../security/pathJail.ts'
import { commandEnvironment } from './commandProcess.ts'
import { gitMissingMessage, resolveGitExecutable } from './gitResolve.ts'

const execFileAsync = promisify(execFile)

const OUTPUT_HARD_CAP = 200_000
const DEFAULT_TIMEOUT_MS = 60_000
const STATUS_TIMEOUT_MS = 30_000
const DIFF_MAX_CHARS = AGENT_LIMITS.maxCommandOutputChars

const FORBIDDEN_GIT_FLAGS = new Set(['--force', '-f', '--no-verify', '-n', '--force-with-lease'])

export class GitError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'GitError'
    this.code = code
  }
}

export type GitCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  truncated: boolean
}

export class GitService {
  private readonly workspaceInput: string
  private readonly root: string
  private gitPath: string | null = null

  constructor(workspacePath: string) {
    this.workspaceInput = workspacePath
    this.root = workspaceRoot(workspacePath)
  }

  workspace(): string {
    return this.root
  }

  async ensureGit(): Promise<string> {
    if (this.gitPath) {
      return this.gitPath
    }
    const resolved = await resolveGitExecutable()
    if (!resolved) {
      throw new GitError('git_not_found', gitMissingMessage())
    }
    this.gitPath = resolved
    return resolved
  }

  private assertSafeArgs(args: string[]): void {
    for (const arg of args) {
      if (FORBIDDEN_GIT_FLAGS.has(arg)) {
        throw new GitError('forbidden_flag', `Git flag "${arg}" is not allowed.`)
      }
      if (arg.startsWith('-') && arg.includes('=')) {
        const flag = arg.split('=')[0]!
        if (FORBIDDEN_GIT_FLAGS.has(flag)) {
          throw new GitError('forbidden_flag', `Git flag "${flag}" is not allowed.`)
        }
      }
    }
  }

  private jailCwd(workingDirectory = '.'): string {
    try {
      return resolveInside(this.workspaceInput, workingDirectory)
    } catch (error) {
      if (error instanceof PathJailError) {
        throw new GitError('path_jail', error.message)
      }
      throw error
    }
  }

  private jailPath(relativePath: string): string {
    const normalized = normalizeRelative(relativePath)
    return resolveInside(this.workspaceInput, normalized)
  }

  async exec(args: string[], options: { cwd?: string; timeoutMs?: number; maxOutput?: number } = {}): Promise<GitCommandResult> {
    this.assertSafeArgs(args)
    const git = await this.ensureGit()
    const cwd = this.jailCwd(options.cwd ?? '.')
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxOutput = options.maxOutput ?? OUTPUT_HARD_CAP
    const env = {
      ...commandEnvironment(),
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      LANG: 'C',
      GIT_OPTIONAL_LOCKS: '0'
    }
    const started = Date.now()
    try {
      const { stdout, stderr } = await execFileAsync(git, args, {
        cwd,
        env,
        encoding: 'buffer',
        maxBuffer: maxOutput + 64_000,
        timeout: timeoutMs,
        windowsHide: true
      })
      const out = boundBuffer(stdout, maxOutput)
      const err = boundBuffer(stderr, maxOutput)
      return {
        exitCode: 0,
        stdout: out.text,
        stderr: err.text,
        durationMs: Date.now() - started,
        truncated: out.truncated || err.truncated
      }
    } catch (error) {
      const record = error as NodeJS.ErrnoException & {
        stdout?: Buffer
        stderr?: Buffer
        code?: number | string
        signal?: string
      }
      if (record.code === 'ETIMEDOUT' || record.signal === 'SIGTERM') {
        throw new GitError('timed_out', 'The git command timed out.')
      }
      const stdout = boundBuffer(record.stdout ?? Buffer.alloc(0), maxOutput)
      const stderr = boundBuffer(record.stderr ?? Buffer.alloc(0), maxOutput)
      const exitCode = typeof record.code === 'number' ? record.code : 1
      return {
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: Date.now() - started,
        truncated: stdout.truncated || stderr.truncated
      }
    }
  }

  private async assertNotInProgressOperation(): Promise<void> {
    const gitDir = path.join(this.root, '.git')
    const markers = [
      { file: path.join(gitDir, 'MERGE_HEAD'), kind: 'merge' as const },
      { file: path.join(gitDir, 'rebase-merge'), kind: 'rebase' as const },
      { file: path.join(gitDir, 'rebase-apply'), kind: 'rebase' as const },
      { file: path.join(gitDir, 'CHERRY_PICK_HEAD'), kind: 'cherry-pick' as const },
      { file: path.join(gitDir, 'REVERT_HEAD'), kind: 'revert' as const },
      { file: path.join(gitDir, 'BISECT_LOG'), kind: 'bisect' as const }
    ]
    for (const marker of markers) {
      if (fs.existsSync(marker.file)) {
        throw new GitError('operation_in_progress', `Git ${marker.kind} is in progress. Resolve it before continuing.`)
      }
    }
  }

  private requireSuccess(result: GitCommandResult, context: string): void {
    if (result.exitCode === 0) {
      return
    }
    const detail = (result.stderr || result.stdout).trim().slice(0, 2_000)
    throw new GitError('git_failed', `${context} failed${detail ? `: ${detail}` : '.'}`)
  }

  async isRepository(): Promise<boolean> {
    const result = await this.exec(['rev-parse', '--is-inside-work-tree'])
    return result.exitCode === 0 && result.stdout.trim() === 'true'
  }

  async status(): Promise<GitStatusResult> {
    const result = await this.exec(['status', '--porcelain=v2', '-z', '--branch'], {
      timeoutMs: STATUS_TIMEOUT_MS
    })
    if (result.exitCode !== 0 && !result.stdout.trim()) {
      this.requireSuccess(result, 'git status')
    }
    const parsed = parsePorcelainV2Z(result.stdout)
    const gitDir = path.join(this.root, '.git')
    if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
      parsed.inProgress = 'merge'
    } else if (
      fs.existsSync(path.join(gitDir, 'rebase-merge')) ||
      fs.existsSync(path.join(gitDir, 'rebase-apply'))
    ) {
      parsed.inProgress = 'rebase'
    }
    return parsed
  }

  async diff(options: { path?: string; staged?: boolean } = {}): Promise<string> {
    const args = ['diff', '--no-color']
    if (options.staged) {
      args.push('--cached')
    }
    if (options.path) {
      const jailPath = this.jailPath(options.path)
      const relative = path.relative(this.root, jailPath).split(path.sep).join('/')
      args.push('--', relative)
    }
    const result = await this.exec(args, { maxOutput: DIFF_MAX_CHARS * 2 })
    if (result.exitCode > 1) {
      this.requireSuccess(result, 'git diff')
    }
    return boundText(result.stdout, DIFF_MAX_CHARS)
  }

  async log(limit = 50): Promise<GitLogEntry[]> {
    const count = Math.min(Math.max(limit, 1), 200)
    const result = await this.exec(
      ['log', `--max-count=${count}`, '--pretty=format:%H%x00%s%x00%an%x00%ae%x00%ad', '--date=iso-strict'],
      { timeoutMs: STATUS_TIMEOUT_MS }
    )
    this.requireSuccess(result, 'git log')
    return parseGitLog(result.stdout, count)
  }

  async init(branch = 'main'): Promise<void> {
    await this.assertNotInProgressOperation()
    const args = ['init']
    if (branch) {
      args.push('-b', branch)
    }
    const result = await this.exec(args)
    this.requireSuccess(result, 'git init')
  }

  async stage(paths: string[]): Promise<void> {
    await this.assertNotInProgressOperation()
    const args = ['add', '--']
    for (const relative of paths) {
      const jailPath = this.jailPath(relative)
      const rel = path.relative(this.root, jailPath).split(path.sep).join('/')
      args.push(rel)
    }
    const result = await this.exec(args)
    this.requireSuccess(result, 'git add')
  }

  async unstage(paths: string[]): Promise<void> {
    await this.assertNotInProgressOperation()
    const args = ['restore', '--staged', '--']
    for (const relative of paths) {
      const jailPath = this.jailPath(relative)
      const rel = path.relative(this.root, jailPath).split(path.sep).join('/')
      args.push(rel)
    }
    const result = await this.exec(args)
    this.requireSuccess(result, 'git restore')
  }

  async commit(message: string): Promise<string> {
    await this.assertNotInProgressOperation()
    const trimmed = message.trim()
    if (!trimmed) {
      throw new GitError('invalid_message', 'Commit message is required.')
    }
    const result = await this.exec(['commit', '-m', trimmed])
    this.requireSuccess(result, 'git commit')
    const hash = await this.exec(['rev-parse', 'HEAD'])
    this.requireSuccess(hash, 'git rev-parse')
    return hash.stdout.trim()
  }

  async createBranch(name: string): Promise<void> {
    await this.assertNotInProgressOperation()
    const result = await this.exec(['branch', name])
    this.requireSuccess(result, 'git branch')
  }

  async switchBranch(name: string): Promise<void> {
    await this.assertNotInProgressOperation()
    const result = await this.exec(['switch', name])
    this.requireSuccess(result, 'git switch')
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.assertNotInProgressOperation()
    const validation = validateRemoteUrl(url)
    if (!validation.ok) {
      throw new GitError('invalid_remote', validation.reason)
    }
    const result = await this.exec(['remote', 'add', name, validation.normalized])
    this.requireSuccess(result, 'git remote add')
  }

  async remotes(): Promise<ReturnType<typeof parseGitRemotes>> {
    const result = await this.exec(['remote', '-v'])
    if (result.exitCode !== 0) {
      return []
    }
    return parseGitRemotes(result.stdout)
  }

  async push(options: { remote?: string; branch?: string; setUpstream?: boolean } = {}): Promise<GitCommandResult> {
    await this.assertNotInProgressOperation()
    const remote = options.remote ?? 'origin'
    const args = ['push']
    if (options.setUpstream) {
      const branch = options.branch ?? (await this.currentBranch())
      args.push('-u', remote, branch)
    } else {
      args.push(remote)
      if (options.branch) {
        args.push(options.branch)
      }
    }
    const result = await this.exec(args, { timeoutMs: AGENT_LIMITS.maxCommandTimeoutMs })
    if (result.exitCode !== 0) {
      const msg = (result.stderr || result.stdout).trim()
      if (/non-fast-forward|rejected/i.test(msg)) {
        throw new GitError('push_rejected', `${msg}\nUse pull or merge on the remote branch; force-push is not allowed.`)
      }
      throw new GitError('push_failed', msg || 'git push failed.')
    }
    return result
  }

  async pullFfOnly(options: { remote?: string; branch?: string } = {}): Promise<void> {
    await this.assertNotInProgressOperation()
    const remote = options.remote ?? 'origin'
    const args = ['pull', '--ff-only', remote]
    if (options.branch) {
      args.push(options.branch)
    }
    const result = await this.exec(args, { timeoutMs: AGENT_LIMITS.maxCommandTimeoutMs })
    this.requireSuccess(result, 'git pull')
  }

  async identity(): Promise<GitIdentityResult> {
    const name = await this.exec(['config', '--get', 'user.name'])
    const email = await this.exec(['config', '--get', 'user.email'])
    const localName = name.exitCode === 0 ? name.stdout.trim() : null
    const localEmail = email.exitCode === 0 ? email.stdout.trim() : null
    return {
      name: localName,
      email: localEmail,
      configured: Boolean(localName && localEmail)
    }
  }

  async setLocalIdentity(name: string, email: string): Promise<void> {
    await this.assertNotInProgressOperation()
    const nameResult = await this.exec(['config', 'user.name', name.trim()])
    this.requireSuccess(nameResult, 'git config user.name')
    const emailResult = await this.exec(['config', 'user.email', email.trim()])
    this.requireSuccess(emailResult, 'git config user.email')
  }

  async currentBranch(): Promise<string> {
    const result = await this.exec(['rev-parse', '--abbrev-ref', 'HEAD'])
    this.requireSuccess(result, 'git rev-parse')
    const branch = result.stdout.trim()
    if (branch === 'HEAD') {
      throw new GitError('detached_head', 'HEAD is detached.')
    }
    return branch
  }

  maskedRemoteUrl(url: string): string {
    return maskRemoteUrl(url)
  }
}

function boundBuffer(buffer: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString('utf8'), truncated: false }
  }
  return {
    text: buffer.subarray(0, maxBytes).toString('utf8') + '\n...[output truncated]...\n',
    truncated: true
  }
}

function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }
  const head = Math.floor(maxChars * 0.65)
  const tail = Math.max(200, maxChars - head - 48)
  const omitted = value.length - head - tail
  return `${value.slice(0, head)}\n...[truncated ${omitted} chars]...\n${value.slice(-tail)}`
}
