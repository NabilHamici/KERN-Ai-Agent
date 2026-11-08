import fs from 'node:fs'
import { z, type ZodError } from 'zod'
import { AGENT_LIMITS } from '../../shared/agent.ts'
import { PathJailError, normalizeRelative, resolveInside } from '../security/pathJail.ts'
import { listWorkspaceTree } from './treeList.ts'

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.pnpm-store', 'coverage'])

const relativePathSchema = z
  .string()
  .max(4096)
  .transform((value) => {
    const trimmed = value.trim()
    return trimmed.length === 0 ? '.' : trimmed
  })

const listSchema = z.strictObject({
  path: relativePathSchema,
  depth: z.number().int().min(1).max(AGENT_LIMITS.maxListDepth).optional(),
  recursive: z.boolean().optional()
})

const readSchema = z.strictObject({
  path: relativePathSchema
})

const ALL_FILES_QUERIES = new Set(['.', '*', '**', '**/*', '**/**'])

const searchSchema = z
  .object({
    query: z.string().min(1).max(200).optional(),
    pattern: z.string().min(1).max(200).optional(),
    path: relativePathSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.query && !value.pattern) {
      context.addIssue({
        code: 'custom',
        message: 'Provide query (preferred) or pattern. Example: {"query":"package.json"}',
        path: ['query']
      })
    }
  })
  .transform((value) => ({
    query: (value.query ?? value.pattern)!,
    path: value.path ?? '.'
  }))

const emptySchema = z.strictObject({})

const completionSchema = z.strictObject({
  outcome: z.enum(['completed', 'blocked', 'partially_completed']),
  summary: z.string().min(1).max(4_000)
})

export const READ_ONLY_TOOLS = ['list_files', 'read_file', 'search_files', 'get_workspace_info'] as const

/** JSON schemas sent to the model. Validators below must accept exactly these fields. */
export const TOOL_PARAMETER_SCHEMAS = {
  list_files: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative directory. Use . for the workspace root.' },
      depth: {
        type: 'number',
        description: `How many directory levels to include. Default 1 (immediate children). Max ${AGENT_LIMITS.maxListDepth}. Prefer one recursive/deep call instead of listing directories one by one.`
      },
      recursive: {
        type: 'boolean',
        description: `When true, returns a nested tree up to depth ${AGENT_LIMITS.maxListDepth} with a hard entry cap. One call is enough for a whole-project inventory.`
      }
    },
    required: ['path'],
    additionalProperties: false
  },
  read_file: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false
  },
  search_files: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Preferred search string for names and contents. Use ".", "*", or "**/*" to mean all files (returns a tree via list semantics). Prefer list_files with recursive:true for inventories.'
      },
      pattern: { type: 'string', description: 'Alias of query. Use query when possible.' },
      path: { type: 'string', description: 'Optional relative directory to scope the search. Defaults to .' }
    },
    required: [],
    additionalProperties: false
  },
  get_workspace_info: { type: 'object', properties: {}, required: [], additionalProperties: false },
  create_file: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      explanation: { type: 'string', description: 'Optional short reason. Defaults to a generated label.' }
    },
    required: ['path', 'content'],
    additionalProperties: false
  },
  edit_file: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      explanation: { type: 'string', description: 'Optional short reason. Defaults to a generated label.' }
    },
    required: ['path', 'content'],
    additionalProperties: false
  },
  delete_file: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Single relative path to delete (file or directory with recursive:true).' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: `Optional batch of relative paths (max ${AGENT_LIMITS.maxDeletePaths}). One approval covers the whole proposal.`
      },
      recursive: {
        type: 'boolean',
        description: 'When true, directories are deleted as a whole tree. Always requires user approval.'
      },
      acknowledge_incomplete_backup: {
        type: 'boolean',
        description: 'Required when a directory/bulk delete backup exceeds the size cap and cannot be fully restored.'
      },
      include_protected: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only after the user explicitly confirms: protected names such as .git or .kern that may be deleted.'
      },
      explanation: { type: 'string', description: 'Optional short reason. Defaults to a generated label.' }
    },
    required: [],
    additionalProperties: false
  },
  rename_file: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Current relative path.' },
      to: { type: 'string', description: 'New relative path.' },
      explanation: { type: 'string', description: 'Optional short reason. Defaults to a generated label.' }
    },
    required: ['path', 'to'],
    additionalProperties: false
  },
  list_file_operations: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional relative path filter.' },
      kind: { type: 'string', enum: ['create', 'edit', 'delete', 'rename', 'restore'] },
      status: {
        type: 'string',
        enum: ['pending', 'approved', 'rejected', 'applied', 'failed', 'cancelled', 'stale']
      },
      limit: { type: 'number' },
      scope: {
        type: 'string',
        enum: ['current_mission', 'workspace'],
        description: 'current_mission (default) or workspace history. History is not the live filesystem.'
      }
    },
    required: [],
    additionalProperties: false
  },
  restore_file: {
    type: 'object',
    properties: {
      operationId: { type: 'string', description: 'Persisted operation UUID from the current mission.' },
      path: { type: 'string', description: 'Relative path to match when operationId is unknown.' },
      explanation: { type: 'string', description: 'Optional short reason. Defaults to a generated label.' }
    },
    required: [],
    additionalProperties: false
  },
  run_command: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Program name or workspace-relative executable. Not a shell string.'
      },
      executable: {
        type: 'string',
        description: 'Documented alias of command. Prefer command.'
      },
      args: { type: 'array', items: { type: 'string' } },
      working_directory: {
        type: 'string',
        description: 'Workspace-relative directory. Use . for the workspace root.'
      },
      workingDirectory: {
        type: 'string',
        description: 'Alias of working_directory. Prefer working_directory.'
      },
      explanation: { type: 'string', description: 'Optional short reason. Defaults to a generated label.' },
      timeout_ms: { type: 'number' }
    },
    required: ['args'],
    additionalProperties: false
  },
  submit_result: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['completed', 'blocked', 'partially_completed'] },
      summary: { type: 'string' }
    },
    required: ['outcome', 'summary'],
    additionalProperties: false
  }
} as const

export const TOOL_ARGUMENT_EXAMPLES: Record<keyof typeof TOOL_PARAMETER_SCHEMAS, Record<string, unknown>> = {
  list_files: { path: '.', recursive: true },
  read_file: { path: 'package.json' },
  search_files: { query: 'package.json' },
  get_workspace_info: {},
  create_file: { path: 'notes.txt', content: 'hello', explanation: 'Add a notes file' },
  edit_file: { path: 'notes.txt', content: 'updated', explanation: 'Update notes' },
  delete_file: { path: 'notes.txt', explanation: 'Remove obsolete notes' },
  rename_file: { path: 'old.txt', to: 'new.txt', explanation: 'Rename the file' },
  list_file_operations: { scope: 'current_mission' },
  restore_file: { operationId: '00000000-0000-0000-0000-000000000000', explanation: 'Restore a current-mission change' },
  run_command: {
    command: 'npm',
    args: ['--version'],
    working_directory: '.',
    explanation: 'Check npm version',
    timeout_ms: 30_000
  },
  submit_result: { outcome: 'completed', summary: 'Deliverables verified.' }
}

export const MODEL_TOOLS = [
  {
    type: 'function',
    name: 'list_files',
    description:
      'List entries in a workspace directory. Paths are relative to the workspace root. Pass recursive:true (or depth>1) for a nested tree in ONE call — do not list directories one by one. Regenerable dirs (node_modules, dist, …) and protected dirs (.git, .kern) appear as single entries and are not descended into.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.list_files
  },
  {
    type: 'function',
    name: 'read_file',
    description: 'Read a text file inside the workspace. Paths are relative.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.read_file
  },
  {
    type: 'function',
    name: 'search_files',
    description:
      'Search file names and text contents inside the workspace. Pass query (preferred) or pattern. Optional path scopes the search. For a whole-tree inventory use list_files with recursive:true; query ".", "*", or "**/*" also returns that tree.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.search_files
  },
  {
    type: 'function',
    name: 'get_workspace_info',
    description: 'Return the open workspace name. This does not expose credentials.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.get_workspace_info
  },
  {
    type: 'function',
    name: 'create_file',
    description:
      'Create a new text file in the workspace. Applied automatically when safe. If the path already exists, the tool edits it instead. Paths are relative. explanation is optional.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.create_file
  },
  {
    type: 'function',
    name: 'edit_file',
    description:
      'Replace the full contents of an existing text file. Applied automatically when the base content still matches. explanation is optional.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.edit_file
  },
  {
    type: 'function',
    name: 'delete_file',
    description:
      'Propose deleting a file, a directory (recursive:true), or a batch of paths (paths:[]). One proposal gets one approval. Never deletes the workspace root, .git, or .kern unless the user named them explicitly. node_modules and similar appear as one regenerable directory. Always requires user approval, including trusted/auto modes. explanation is optional.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.delete_file
  },
  {
    type: 'function',
    name: 'rename_file',
    description:
      'Rename or move a file within the workspace. Applied automatically when safe. explanation is optional.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.rename_file
  },
  {
    type: 'function',
    name: 'list_file_operations',
    description:
      'Search persisted agent file-operation history. Default scope is the current mission. Results are history records, not live disk state. Use list_files/read_file for the filesystem. Prefer restore_file only for changes made in the current mission.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.list_file_operations
  },
  {
    type: 'function',
    name: 'restore_file',
    description:
      'Restore an applied file operation. Path-based restore searches the current mission only. Pass an explicit operationId only when the user asked to recover a prior change. The live filesystem is the source of truth; do not restore old scaffolds to create a new project.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.restore_file
  },
  {
    type: 'function',
    name: 'run_command',
    description:
      'Run one development command inside the workspace. Pass command (or alias executable) and an args array. This is not a shell string — put the program in command and each argument in args, e.g. {"command":"pnpm","args":["exec","tsc","--noEmit"]}. Use working_directory (or alias workingDirectory). explanation is optional.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.run_command
  },
  {
    type: 'function',
    name: 'submit_result',
    description:
      'Finish the mission. Use completed only when required work is done and verified by a real check command when relevant. Use partially_completed when some deliverables were applied but others remain. Use blocked when the mission cannot continue. Plain text does not finish a mission.',
    strict: true,
    parameters: TOOL_PARAMETER_SCHEMAS.submit_result
  }
] as const

export type ToolExecution = {
  state: 'success' | 'rejected' | 'awaiting_approval' | 'failed' | 'cancelled' | 'running'
  output: string
}

export type ReadCache = {
  files: Map<string, string>
}

function rejected(error: string): ToolExecution {
  return {
    state: 'rejected',
    output: JSON.stringify({ ok: false, outcome: 'rejected', error })
  }
}

function failed(error: string): ToolExecution {
  return {
    state: 'failed',
    output: JSON.stringify({ ok: false, outcome: 'failed', error })
  }
}

export function argumentError(error: ZodError, toolName?: keyof typeof TOOL_PARAMETER_SCHEMAS): string {
  const parts = error.issues.slice(0, 4).map((issue) => {
    const field = issue.path.length > 0 ? issue.path.map(String).join('.') : 'arguments'
    if (issue.code === 'unrecognized_keys' && 'keys' in issue && Array.isArray(issue.keys)) {
      return `${field}: unrecognized key ${issue.keys.join(', ')}. Only documented fields are accepted.`
    }
    if (issue.code === 'too_small' && field === 'path') {
      return 'path: must be a relative path. Use "." for the workspace root.'
    }
    if (issue.code === 'too_small' && (field === 'query' || field === 'pattern')) {
      return `${field}: must be a non-empty string.`
    }
    return `${field}: ${issue.message}`
  })
  const schema = toolName ? TOOL_PARAMETER_SCHEMAS[toolName] : null
  const example = toolName ? TOOL_ARGUMENT_EXAMPLES[toolName] : null
  const expected = schema
    ? ` Expected fields: ${Object.keys(schema.properties).join(', ') || '(none)'}. Example: ${JSON.stringify(example)}.`
    : ''
  return `Tool arguments were rejected. ${parts.join(' ')}.${expected}`
}

function finished(payload: Record<string, unknown>): ToolExecution {
  let body: Record<string, unknown> = { outcome: 'success', ...payload }
  let output = JSON.stringify(body)
  if (output.length > AGENT_LIMITS.maxToolOutputChars && Array.isArray(body.entries)) {
    const entries = body.entries as unknown[]
    let keep = entries.length
    while (keep > 20) {
      keep = Math.floor(keep * 0.7)
      body = {
        ...body,
        entries: entries.slice(0, keep),
        truncated: true,
        entryCount: keep,
        note: `${typeof body.note === 'string' ? `${body.note} ` : ''}Output capped at ${AGENT_LIMITS.maxToolOutputChars} chars; ${entries.length - keep} entries omitted.`
      }
      output = JSON.stringify(body)
      if (output.length <= AGENT_LIMITS.maxToolOutputChars) {
        break
      }
    }
  }
  if (output.length <= AGENT_LIMITS.maxToolOutputChars) {
    return { state: 'success', output }
  }
  return {
    state: 'success',
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

export function parseCompletion(
  argumentsText: string
):
  | { ok: true; value: { outcome: 'completed' | 'blocked' | 'partially_completed'; summary: string } }
  | { ok: false; error: string } {
  const parsed = parseArguments(argumentsText)
  if (!parsed.ok) {
    return { ok: false, error: 'Tool arguments were not valid JSON.' }
  }
  const result = completionSchema.safeParse(parsed.value)
  if (!result.success) {
    return { ok: false, error: argumentError(result.error, 'submit_result') }
  }
  return { ok: true, value: result.data }
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
        return rejected(argumentError(args.error, 'get_workspace_info'))
      }
      return finished({ ok: true, name: workspaceName, open: true })
    }
    if (name === 'list_files') {
      const args = listSchema.safeParse(parsed.value)
      if (!args.success) {
        return rejected(argumentError(args.error, 'list_files'))
      }
      return listFiles(root, args.data.path, {
        depth: args.data.depth ?? 1,
        recursive: args.data.recursive === true
      })
    }
    if (name === 'read_file') {
      const args = readSchema.safeParse(parsed.value)
      if (!args.success) {
        return rejected(argumentError(args.error, 'read_file'))
      }
      return readFile(root, args.data.path, cache)
    }
    const args = searchSchema.safeParse(parsed.value)
    if (!args.success) {
      return rejected(argumentError(args.error, 'search_files'))
    }
    if (ALL_FILES_QUERIES.has(args.data.query.trim())) {
      return listFiles(root, args.data.path, { depth: AGENT_LIMITS.maxListDepth, recursive: true })
    }
    return searchFiles(root, args.data.query, args.data.path)
  } catch (error) {
    if (error instanceof PathJailError) {
      return rejected(error.message)
    }
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return rejected('Path does not exist')
    }
    return failed('Tool failed.')
  }
}

function listFiles(
  root: string,
  relativePath: string,
  options: { depth: number; recursive: boolean } = { depth: 1, recursive: false }
): ToolExecution {
  const relative = normalizeRelative(relativePath)
  try {
    const tree = listWorkspaceTree(root, relative, options)
    return finished({
      ok: true,
      path: tree.path,
      depth: tree.depth,
      recursive: tree.recursive,
      entries: tree.entries,
      entryCount: tree.entryCount,
      truncated: tree.truncated,
      truncatedDirectories: tree.truncatedDirectories,
      note: tree.recursive
        ? 'Nested tree from one call. Prefer this over listing directories one by one. Protected/regenerable dirs are single entries.'
        : undefined
    })
  } catch (error) {
    if (error instanceof PathJailError) {
      return rejected(error.message)
    }
    throw error
  }
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

function searchFiles(root: string, query: string, relativePath = '.'): ToolExecution {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return rejected(
      `Tool arguments were rejected. query: must contain a non-space character. Expected fields: query, pattern, path. Example: ${JSON.stringify(TOOL_ARGUMENT_EXAMPLES.search_files)}.`
    )
  }
  const start = normalizeRelative(relativePath)
  if (start !== '.' && excluded(start)) {
    return rejected('That directory is excluded from agent reads.')
  }
  const matches: Array<{ path: string; line: number | null; text: string | null }> = []
  const queue = [start]
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
