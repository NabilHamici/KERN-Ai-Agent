import fs from 'node:fs'
import path from 'node:path'
import { spawn, type IPty } from 'node-pty'
import { isAlive, killProcessGroup } from './processGroup.mjs'

type Session = {
  pty: IPty
  pid: number
  shell: string
}

const SHELL_CANDIDATES = ['/bin/zsh', '/bin/bash', '/bin/sh']

function executableShell(): string {
  const requested = process.env.SHELL
  const candidates = requested && path.isAbsolute(requested) ? [requested, ...SHELL_CANDIDATES] : SHELL_CANDIDATES
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  throw new Error('No shell is available')
}

function terminalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' }
  delete env.KERN_ACCEPTANCE_SECRET
  return env
}

export class TerminalService {
  private session: Session | null = null

  start(cwd: string, onData: (data: string) => void, onExit: (exitCode: number) => void): { shell: string } {
    if (!fs.statSync(cwd).isDirectory()) {
      throw new Error('No workspace is open')
    }
    this.cancel()
    const shell = executableShell()
    const pty = spawn(shell, ['-i'], {
      name: 'xterm-256color',
      cwd,
      env: terminalEnvironment(),
      cols: 80,
      rows: 24
    })
    this.session = { pty, pid: pty.pid, shell }
    pty.onData(onData)
    pty.onExit(({ exitCode }) => {
      if (this.session?.pid === pty.pid) {
        this.session = null
      }
      onExit(exitCode)
    })
    return { shell }
  }

  write(data: string): void {
    if (!this.session) {
      throw new Error('Terminal is not running')
    }
    this.session.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.session) {
      throw new Error('Terminal is not running')
    }
    this.session.pty.resize(cols, rows)
  }

  cancel(): { stopped: boolean } {
    const session = this.session
    if (!session) {
      return { stopped: true }
    }
    killProcessGroup(session.pid)
    try {
      session.pty.kill()
    } catch {
      // The process group signal already ended the session.
    }
    const stopped = !isAlive(session.pid)
    this.session = null
    return { stopped }
  }

  pid(): number | null {
    return this.session?.pid ?? null
  }
}
