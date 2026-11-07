import fs from 'node:fs'
import { z, type ZodError } from 'zod'
import { AGENT_LIMITS } from '../../shared/agent.ts'
import { PathJailError, normalizeRelative, resolveInside } from '../security/pathJail.ts'

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.pnpm-store', 'coverage'])

const listSchema = z.strictObject({
  path: z.string().min(1).max(4096)
})

const readSchema = z.strictObject({
  path: z.string().min(1).max(4096)
})

const searchSchema = z.strictObject({
  query: z.string().min(1).max(200)
})

const emptySchema = z.strictObject({})

const completionSchema = z.strictObject({
  outcome: z.enum(['completed', 'blocked']),
  summary: z.string().min(1).max(4_000)
})

export const READ_ONLY_TOOLS = ['list_files', 'read_file', 'search_files', 'get_workspace_info'] as const

export const MODEL_TOOLS = [
  {
    type: 'function',
    name: 'list_files',
    description: 'List entries in a workspace directory. Paths are relative to the workspace root.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative directory. Use . for the workspace root.' } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'read_file',
    description: 'Read a text file inside the workspace. Paths are relative.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'search_files',
    description: 'Search file names and text contents inside the workspace.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'get_workspace_info',
    description: 'Return the open workspace name. This does not expose credentials.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    type: 'function',
    name: 'submit_result',
    description: 'Finish the mission. outcome completed means the answer is done. outcome blocked means the mission cannot continue. Plain text does not finish a mission.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['completed', 'blocked'] },
        summary: { type: 'string' }
      },
      required: ['outcome', 'summary'],
      additionalProperties: false
    }
  }
] as const

export type ToolExecution = {
  state: 'finished' | 'rejected'
  output: string
}

export type ReadCache = {
  files: Map<string, string>
}

function rejected(error: string): ToolExecution {
  return { state: 'rejected', output: JSON.stringify({ ok: false, error }) }
}

function argumentError(error: ZodError): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const field = issue.path.length > 0 ? issue.path.map(String).join('.') : 'arguments'
    if (issue.code === 'unrecognized_keys' && 'keys' in issue && Array.isArray(issue.keys)) {
      return `${field}: unrecognized key ${issue.keys.join(', ')}. Only documented fields are accepted.`
    }
    if (issue.code === 'too_small' && field === 'path') {
      return 'path: must be a non-empty relative path. Use "." for the workspace root.'
    }
    if (issue.code === 'too_small' && field === 'query') {
      return 'query: must be a non-empty string.'
    }
    return `${field}: ${issue.message}`
  })
  return `Tool arguments were rejected. ${parts.join(' ')}`
}

function finished(payload: unknown): ToolExecution {
  const output = JSON.stringify(payload)
  if (output.length <= AGENT_LIMITS.maxToolOutputChars) {
    return { state: 'finished', output }
  }
  return {
    state: 'finished',
    output: `${output.slice(0, AGENT_LIMITS.maxToolOutputChars)}\n[output truncated]`
  }
}

function excluded(relativePath: string): boolean {
  const parts = relativePath.split('/')
  if (parts.some((part) => SKIPPED_DIRECTORIES.has(part))) {
    return true
  }
  const base = parts[parts.length - 1] ?? ''
  return base === '.env' || base.startsWith('.env.') || base === 'api-key.bin' || base === 'cursor-api-key.bin' || base.endsWith('.sqlite')
}

function parseArguments(argumentsText: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(argumentsText) as unknown }
  } catch {
    return { ok: false }
  }
}

export function parseCompletion(argumentsText: string): { outcome: 'completed' | 'blocked'; summary: string } | null {
  const parsed = parseArguments(argumentsText)
  if (!parsed.ok) {
    return null
  }
  const result = completionSchema.safeParse(parsed.value)
  return result.success ? result.data : null
}

export function executeTool(
  root: string,
  workspaceName: string,
  name: string,
  argumentsText: string,
  cache?: ReadCache
): ToolExecution {
  if (!(READ_ONLY_TOOLS as readonly string[]).includes(name)) {
    return rejected('Tool is not available.')
  }
  const parsed = parseArguments(argumentsText)
  if (!parsed.ok) {
    return rejected('Tool arguments were not valid JSON.')
  }
  try {
    if (name === 'get_workspace_info') {
      const args = emptySchema.safeParse(parsed.value)
      if (!args.success) {
        return rejected(argumentError(args.error))
      }
      return finished({ ok: true, name: workspaceName, open: true })
    }
    if (name === 'list_files') {
      const args = listSchema.safeParse(parsed.value)
      if (!args.success) {
        return rejected(argumentError(args.error))
      }
      return listFiles(root, args.data.path)
    }
    if (name === 'read_file') {
      const args = readSchema.safeParse(parsed.value)
      if (!args.success) {
        return rejected(argumentError(args.error))
      }
      return readFile(root, args.data.path, cache)
    }
    const args = searchSchema.safeParse(parsed.value)
    if (!args.success) {
      return rejected(argumentError(args.error))
    }
    return searchFiles(root, args.data.query)
  } catch (error) {
    if (error instanceof PathJailError) {
      return rejected(error.message)
    }
    return rejected('Tool failed.')
  }
}

function listFiles(root: string, relativePath: string): ToolExecution {
  const relative = normalizeRelative(relativePath)
  if (relative !== '.' && excluded(relative)) {
    return rejected('That directory is excluded from agent reads.')
  }
  const directory = resolveInside(root, relative)
  if (!fs.statSync(directory).isDirectory()) {
    return rejected('Not a directory')
  }
  const names = fs.readdirSync(directory).filter((name) => !SKIPPED_DIRECTORIES.has(name) && !excluded(name)).sort()
  const entries = names.slice(0, AGENT_LIMITS.maxListEntries).map((name) => {
    const child = relative === '.' ? name : `${relative}/${name}`
    try {
      const resolved = resolveInside(root, child)
      const kind = fs.statSync(resolved).isDirectory() ? 'directory' : 'file'
      return { path: child, kind }
    } catch {
      return { path: child, kind: 'blocked' }
    }
  })
  return finished({ ok: true, path: relative, entries, truncated: names.length > entries.length })
}

function readFile(root: string, relativePath: string, cache?: ReadCache): ToolExecution {
  const relative = normalizeRelative(relativePath)
  if (excluded(relative)) {
    return rejected('That file is excluded from agent reads.')
  }
  const target = resolveInside(root, relative)
  const stat = fs.statSync(target)
  if (!stat.isFile()) {
    return rejected('Not a file')
  }
  if (stat.size > 2_000_000) {
    return rejected('File is too large to read')
  }
  const identity = `${stat.dev}:${stat.ino}`
  const prior = cache?.files.get(identity)
  if (prior) {
    return finished({ ok: true, path: relative, duplicate: true, sameAs: prior })
  }
  const bytes = fs.readFileSync(target)
  if (bytes.includes(0)) {
    return rejected('Binary files cannot be read')
  }
  const content = bytes.toString('utf8')
  const truncated = content.length > AGENT_LIMITS.maxToolOutputChars
  cache?.files.set(identity, relative)
  return finished({
    ok: true,
    path: relative,
    truncated,
    content: truncated ? content.slice(0, AGENT_LIMITS.maxToolOutputChars) : content
  })
}

function searchFiles(root: string, query: string): ToolExecution {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return rejected('Tool arguments were rejected. query: must contain a non-space character.')
  }
  const matches: Array<{ path: string; line: number | null; text: string | null }> = []
  const queue = ['.']
  const seen = new Set<string>()
  while (queue.length > 0 && matches.length < AGENT_LIMITS.maxSearchResults && seen.size < 400) {
    const directory = queue.shift()
    if (!directory || seen.has(directory)) {
      continue
    }
    seen.add(directory)
    let names: string[]
    try {
      names = fs.readdirSync(resolveInside(root, directory))
    } catch (error) {
      if (error instanceof PathJailError) {
        continue
      }
      throw error
    }
    for (const name of names) {
      if (SKIPPED_DIRECTORIES.has(name) || excluded(name)) {
        continue
      }
      const relative = directory === '.' ? name : `${directory}/${name}`
      if (excluded(relative)) {
        continue
      }
      let resolved: string
      try {
        resolved = resolveInside(root, relative)
      } catch (error) {
        if (error instanceof PathJailError) {
          continue
        }
        throw error
      }
      const stat = fs.statSync(resolved)
      if (stat.isDirectory()) {
        queue.push(relative)
      }
      if (relative.toLowerCase().includes(needle) && matches.length < AGENT_LIMITS.maxSearchResults) {
        matches.push({ path: relative, line: null, text: null })
      }
      if (!stat.isFile() || stat.size > 65_536 || matches.length >= AGENT_LIMITS.maxSearchResults) {
        continue
      }
      const bytes = fs.readFileSync(resolved)
      if (bytes.includes(0)) {
        continue
      }
      const lines = bytes.toString('utf8').split(/\r?\n/)
      for (let index = 0; index < lines.length && matches.length < AGENT_LIMITS.maxSearchResults; index += 1) {
        if (lines[index]?.toLowerCase().includes(needle)) {
          matches.push({ path: relative, line: index + 1, text: (lines[index] ?? '').slice(0, 180) })
        }
      }
    }
  }
  return finished({ ok: true, matches })
}
