import fs from 'node:fs'
import path from 'node:path'

export class PathJailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathJailError'
  }
}

const MAX_PATH = 4096

export function normalizeRelative(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_PATH) {
    throw new PathJailError('Path is invalid')
  }
  if (input.includes('\0')) {
    throw new PathJailError('Path is invalid')
  }
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input) || path.isAbsolute(input)) {
    throw new PathJailError('Path escapes the workspace')
  }
  const normalized = path.posix.normalize(input).replace(/^\.\//, '')
  if (normalized === '' || normalized === '.') {
    return '.'
  }
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.endsWith('/..')
  ) {
    throw new PathJailError('Path escapes the workspace')
  }
  const parts = normalized.split('/')
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new PathJailError('Path escapes the workspace')
  }
  return parts.join('/')
}

export function workspaceRoot(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new PathJailError('Workspace is not a directory')
  }
  let real: string
  try {
    real = fs.realpathSync(input)
  } catch {
    throw new PathJailError('Workspace is not a directory')
  }
  const stat = fs.statSync(real)
  if (!stat.isDirectory()) {
    throw new PathJailError('Workspace is not a directory')
  }
  return real
}

function assertInsideRoot(root: string, candidate: string): void {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  if (candidate !== root && !candidate.startsWith(prefix)) {
    throw new PathJailError('Path escapes the workspace')
  }
}

function exists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch {
    return false
  }
}

export function resolveInside(rootInput: string, relativePath: string): string {
  const root = workspaceRoot(rootInput)
  const relative = normalizeRelative(relativePath)
  if (relative === '.') {
    return root
  }

  const parts = relative.split('/')
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    const nextLexical = path.join(current, parts[index]!)
    assertInsideRoot(root, nextLexical)
    const isLast = index === parts.length - 1
    if (!exists(nextLexical)) {
      if (!isLast) {
        throw new PathJailError('Path does not exist')
      }
      const parentReal = fs.realpathSync(current)
      assertInsideRoot(root, parentReal)
      const finalPath = path.join(parentReal, parts[index]!)
      assertInsideRoot(root, finalPath)
      return finalPath
    }

    const stat = fs.lstatSync(nextLexical)
    if (stat.isSymbolicLink()) {
      let target: string
      try {
        target = fs.realpathSync(nextLexical)
      } catch {
        throw new PathJailError('Path escapes the workspace')
      }
      assertInsideRoot(root, target)
      if (isLast) {
        return target
      }
      const targetStat = fs.statSync(target)
      if (!targetStat.isDirectory()) {
        throw new PathJailError('Path does not exist')
      }
      current = target
      continue
    }

    if (isLast) {
      const real = fs.realpathSync(nextLexical)
      assertInsideRoot(root, real)
      return real
    }
    if (!stat.isDirectory()) {
      throw new PathJailError('Path does not exist')
    }
    current = fs.realpathSync(nextLexical)
    assertInsideRoot(root, current)
  }

  throw new PathJailError('Path is invalid')
}

export type WorkspaceEntry = {
  root: string
  lexical: string
  exists: boolean
  isSymbolicLink: boolean
}

export function resolveEntry(rootInput: string, relativePath: string): WorkspaceEntry {
  const root = workspaceRoot(rootInput)
  const relative = normalizeRelative(relativePath)
  if (relative === '.') {
    return { root, lexical: root, exists: true, isSymbolicLink: false }
  }
  const parentRelative = path.posix.dirname(relative)
  const name = path.posix.basename(relative)
  const parent = parentRelative === '.' ? root : resolveInside(root, parentRelative)
  if (!fs.statSync(parent).isDirectory()) {
    throw new PathJailError('Not a directory')
  }
  const lexical = path.join(parent, name)
  assertInsideRoot(root, lexical)
  const isThere = exists(lexical)
  return {
    root,
    lexical,
    exists: isThere,
    isSymbolicLink: isThere && fs.lstatSync(lexical).isSymbolicLink()
  }
}
