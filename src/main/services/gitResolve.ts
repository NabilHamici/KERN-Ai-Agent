import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

let cachedGitPath: string | null | undefined

const COMMON_MAC_PATHS = [
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
  '/Library/Developer/CommandLineTools/usr/bin/git',
  '/usr/bin/git'
]

const COMMON_WIN_PATHS = [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  'C:\\Program Files\\Git\\bin\\git.exe'
]

function loginShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe'
  }
  const shell = process.env.SHELL
  if (shell && fs.existsSync(shell)) {
    return shell
  }
  const fallbacks = ['/bin/zsh', '/bin/bash', '/bin/sh']
  for (const candidate of fallbacks) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return '/bin/sh'
}

async function resolveViaLoginShell(): Promise<string | null> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('where', ['git'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000
      })
      const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
      return first ? first.trim() : null
    } catch {
      return null
    }
  }
  const shell = loginShell()
  const name = path.basename(shell)
  const args =
    name === 'fish'
      ? ['-l', '-c', 'command -v git']
      : ['-l', '-c', 'command -v git || which git']
  try {
    const { stdout } = await execFileAsync(shell, args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
      },
      timeout: 8_000
    })
    const resolved = stdout.trim().split('\n')[0]?.trim()
    if (resolved && fs.existsSync(resolved)) {
      return resolved
    }
  } catch {
    // Fall through to common paths.
  }
  return null
}

function resolveFromCommonPaths(): string | null {
  const candidates = process.platform === 'win32' ? COMMON_WIN_PATHS : COMMON_MAC_PATHS
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    } catch {
      // Ignore unreadable paths.
    }
  }
  return null
}

function resolveFromPathEnv(): string | null {
  const segments = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
  const executable = process.platform === 'win32' ? 'git.exe' : 'git'
  for (const segment of segments) {
    const candidate = path.join(segment, executable)
    try {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    } catch {
      // Ignore.
    }
  }
  return null
}

export async function resolveGitExecutable(options?: { refresh?: boolean }): Promise<string | null> {
  if (!options?.refresh && cachedGitPath !== undefined) {
    return cachedGitPath
  }
  let resolved = await resolveViaLoginShell()
  if (!resolved) {
    resolved = resolveFromPathEnv()
  }
  if (!resolved) {
    resolved = resolveFromCommonPaths()
  }
  cachedGitPath = resolved
  return resolved
}

export function resetGitExecutableCache(): void {
  cachedGitPath = undefined
}

export function gitMissingMessage(): string {
  if (process.platform === 'darwin') {
    return 'Git was not found. Install Xcode Command Line Tools (`xcode-select --install`) or Homebrew (`brew install git`), then restart KERN.'
  }
  if (process.platform === 'win32') {
    return 'Git was not found. Install Git for Windows from https://git-scm.com/download/win, then restart KERN.'
  }
  return 'Git was not found. Install git with your system package manager and restart KERN.'
}
