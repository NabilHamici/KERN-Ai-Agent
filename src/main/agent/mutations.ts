import crypto from 'node:crypto'
import fs from 'node:fs'
import { z } from 'zod'
import {
  AGENT_LIMITS,
  AgentError,
  type AgentOperationSummary,
  type MutationToolName,
  type OperationKind
} from '../../shared/agent.ts'
import { unifiedDiff } from '../../shared/diff.ts'
import { PathJailError, normalizeRelative, resolveEntry, resolveInside } from '../security/pathJail.ts'
import type { MissionDatabase, AgentOperationRecord } from '../services/database.ts'
import type { WorkspaceService } from '../services/workspace.ts'
import {
  buildDeletePlan,
  formatDeleteDiff,
  isTreeSnapshot,
  parseDeleteSnapshot,
  restoreTreeSnapshot
} from './deletePlan.ts'
import { argumentError, type ToolExecution } from './tools.ts'

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.pnpm-store', 'coverage'])

const optionalExplanation = z.string().max(500).optional()

const createSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  content: z.string().max(AGENT_LIMITS.maxProposalChars),
  explanation: optionalExplanation
})

const editSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  content: z.string().max(AGENT_LIMITS.maxProposalChars),
  explanation: optionalExplanation
})

const deleteSchema = z
  .object({
    path: z.string().min(1).max(4096).optional(),
    paths: z.array(z.string().min(1).max(4096)).max(AGENT_LIMITS.maxDeletePaths).optional(),
    recursive: z.boolean().optional(),
    acknowledge_incomplete_backup: z.boolean().optional(),
    include_protected: z.array(z.string().min(1).max(4096)).max(8).optional(),
    explanation: optionalExplanation
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.path && (!value.paths || value.paths.length === 0)) {
      context.addIssue({
        code: 'custom',
        message: 'Provide path or paths. Example: {"path":"notes.txt","explanation":"Remove obsolete notes"}',
        path: ['path']
      })
    }
  })

const renameSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  to: z.string().min(1).max(4096),
  explanation: optionalExplanation
})

const listOperationsSchema = z.strictObject({
  path: z.string().min(1).max(4096).optional(),
  kind: z.enum(['create', 'edit', 'delete', 'rename', 'restore']).optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'applied', 'failed', 'cancelled', 'stale']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  scope: z.enum(['current_mission', 'workspace']).optional()
})

const restoreSchema = z.strictObject({
  operationId: z
    .string()
    .min(36)
    .max(36)
    .refine((value) => /^[0-9a-f-]{36}$/i.test(value), { error: 'Invalid operation id' })
    .optional(),
  path: z.string().min(1).max(4096).optional(),
  explanation: optionalExplanation
})

function defaultExplanation(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

export function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export function contentFingerprint(parts: {
  kind: OperationKind
  path: string
  toPath: string | null
  explanation: string
  originalText: string | null
  proposedText: string | null
  baseHash: string | null
  sourceOperationId?: string | null
}): string {
  return contentHash(
    JSON.stringify({
      kind: parts.kind,
      path: parts.path,
      toPath: parts.toPath,
      explanation: parts.explanation,
      originalText: parts.originalText,
      proposedText: parts.proposedText,
      baseHash: parts.baseHash,
      sourceOperationId: parts.sourceOperationId ?? null
    })
  )
}

export function excludedMutationPath(relativePath: string): boolean {
  const parts = relativePath.split('/')
  if (parts.some((part) => SKIPPED_DIRECTORIES.has(part))) {
    return true
  }
  const base = parts[parts.length - 1] ?? ''
  return base === '.env' || base.startsWith('.env.') || base === 'api-key.bin' || base === 'cursor-api-key.bin' || base.endsWith('.sqlite')
}

function rejected(error: string): ToolExecution {
  return { state: 'rejected', output: JSON.stringify({ ok: false, outcome: 'rejected', error }) }
}

function failed(error: string): ToolExecution {
  return { state: 'failed', output: JSON.stringify({ ok: false, outcome: 'failed', error }) }
}

export function mutationErrorMessage(error: unknown): string {
  if (error instanceof PathJailError || error instanceof AgentError) {
    return error.message
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code)
    if (code === 'ENOENT') return 'Path does not exist.'
    if (code === 'EEXIST') return 'Path already exists.'
    if (code === 'ENOTDIR') return 'A parent path is not a directory.'
    if (code === 'EISDIR') return 'Path is a directory.'
    if (code === 'EACCES' || code === 'EPERM') return 'The file could not be written.'
  }
  return 'Tool failed.'
}

function finished(payload: Record<string, unknown>): ToolExecution {
  const output = JSON.stringify({ outcome: 'success', ...payload })
  if (output.length <= AGENT_LIMITS.maxToolOutputChars) {
    return { state: 'success', output }
  }
  return { state: 'success', output: `${output.slice(0, AGENT_LIMITS.maxToolOutputChars)}\n[output truncated]` }
}

function parseArguments(argumentsText: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(argumentsText) as unknown }
  } catch {
    return { ok: false }
  }
}

function readTextIfPresent(root: string, relative: string): string | null {
  const entry = resolveEntry(root, relative)
  if (!entry.exists) {
    return null
  }
  if (entry.isSymbolicLink) {
    throw new PathJailError('Symbolic links cannot be mutated by the agent')
  }
  const target = resolveInside(root, relative)
  const stat = fs.statSync(target)
  if (!stat.isFile()) {
    throw new PathJailError('Not a file')
  }
  if (stat.size > AGENT_LIMITS.maxProposalChars) {
    throw new PathJailError('File is too large for an agent proposal')
  }
  const bytes = fs.readFileSync(target)
  if (bytes.includes(0)) {
    throw new PathJailError('Binary files cannot be mutated by the agent')
  }
  return bytes.toString('utf8')
}

function currentHash(root: string, relative: string): string | null {
  const text = readTextIfPresent(root, relative)
  return text === null ? null : contentHash(text)
}

export type ProposeResult = {
  execution: ToolExecution
  operation: AgentOperationSummary | null
}

export function proposeMutation(input: {
  root: string
  database: MissionDatabase
  missionId: string
  callId: string
  workspacePath: string
  name: MutationToolName
  argumentsText: string
}): ProposeResult {
  const parsed = parseArguments(input.argumentsText)
  if (!parsed.ok) {
    return { execution: rejected('Tool arguments were not valid JSON.'), operation: null }
  }
  try {
    if (input.name === 'create_file') {
      const args = createSchema.safeParse(parsed.value)
      if (!args.success) {
        return { execution: rejected(argumentError(args.error, 'create_file')), operation: null }
      }
      return proposeCreate(
        input,
        args.data.path,
        args.data.content,
        defaultExplanation(args.data.explanation, `Create ${args.data.path}`)
      )
    }
    if (input.name === 'edit_file') {
      const args = editSchema.safeParse(parsed.value)
      if (!args.success) {
        return { execution: rejected(argumentError(args.error, 'edit_file')), operation: null }
      }
      return proposeEdit(
        input,
        args.data.path,
        args.data.content,
        defaultExplanation(args.data.explanation, `Edit ${args.data.path}`)
      )
    }
    if (input.name === 'delete_file') {
      const args = deleteSchema.safeParse(parsed.value)
      if (!args.success) {
        return { execution: rejected(argumentError(args.error, 'delete_file')), operation: null }
      }
      const target = args.data.path ?? args.data.paths?.[0] ?? 'paths'
      return proposeDelete(input, {
        path: args.data.path,
        paths: args.data.paths,
        recursive: args.data.recursive === true,
        acknowledgeIncompleteBackup: args.data.acknowledge_incomplete_backup === true,
        includeProtected: args.data.include_protected,
        explanation: defaultExplanation(args.data.explanation, `Delete ${target}`)
      })
    }
    if (input.name === 'restore_file') {
      const args = restoreSchema.safeParse(parsed.value)
      if (!args.success) {
        return { execution: rejected(argumentError(args.error, 'restore_file')), operation: null }
      }
      if (!args.data.operationId && !args.data.path) {
        return { execution: rejected('Provide operationId or path for restore_file.'), operation: null }
      }
      return proposeRestore(
        input,
        args.data.operationId,
        args.data.path,
        defaultExplanation(args.data.explanation, `Restore ${args.data.path ?? 'file'}`)
      )
    }
    const args = renameSchema.safeParse(parsed.value)
    if (!args.success) {
      return { execution: rejected(argumentError(args.error, 'rename_file')), operation: null }
    }
    return proposeRename(
      input,
      args.data.path,
      args.data.to,
      defaultExplanation(args.data.explanation, `Rename ${args.data.path}`)
    )
  } catch (error) {
    return { execution: rejected(mutationErrorMessage(error)), operation: null }
  }
}

function proposeCreate(
  input: { root: string; database: MissionDatabase; missionId: string; callId: string },
  relativePath: string,
  content: string,
  explanation: string
): ProposeResult {
  const path = normalizeRelative(relativePath)
  if (excludedMutationPath(path)) {
    return { execution: rejected('That path is excluded from agent edits.'), operation: null }
  }
  const entry = resolveEntry(input.root, path)
  if (entry.lexical === entry.root) {
    return { execution: rejected('Refusing to create the workspace root.'), operation: null }
  }
  if (entry.exists) {
    const original = readTextIfPresent(input.root, path)
    if (original === null) {
      return { execution: rejected('Path already exists and cannot be read for an edit.'), operation: null }
    }
    if (original === content) {
      return {
        execution: finished({
          ok: true,
          applied: true,
          noop: true,
          path,
          status: 'applied',
          reason: 'File already exists with identical content.'
        }),
        operation: null
      }
    }
    // Convert mistaken duplicate creates into intentional edits of the current file.
    return proposeEdit(
      input,
      path,
      content,
      `${explanation} (converted from create_file because the path already exists)`
    )
  }
  return persistProposal(input, {
    kind: 'create',
    path,
    toPath: null,
    explanation,
    originalText: null,
    proposedText: content,
    baseHash: null,
    diff: unifiedDiff(path, null, content)
  })
}

function proposeEdit(
  input: { root: string; database: MissionDatabase; missionId: string; callId: string },
  relativePath: string,
  content: string,
  explanation: string
): ProposeResult {
  const path = normalizeRelative(relativePath)
  if (excludedMutationPath(path)) {
    return { execution: rejected('That path is excluded from agent edits.'), operation: null }
  }
  const original = readTextIfPresent(input.root, path)
  if (original === null) {
    return { execution: rejected('Path does not exist.'), operation: null }
  }
  const baseHash = contentHash(original)
  return persistProposal(input, {
    kind: 'edit',
    path,
    toPath: null,
    explanation,
    originalText: original,
    proposedText: content,
    baseHash,
    diff: unifiedDiff(path, original, content)
  })
}

function proposeDelete(
  input: { root: string; database: MissionDatabase; missionId: string; callId: string },
  args: {
    path?: string
    paths?: string[]
    recursive: boolean
    acknowledgeIncompleteBackup: boolean
    includeProtected?: string[]
    explanation: string
  }
): ProposeResult {
  try {
    const plan = buildDeletePlan({
      root: input.root,
      path: args.path,
      paths: args.paths,
      recursive: args.recursive,
      includeProtected: args.includeProtected
    })
    if (!plan.snapshotComplete && !args.acknowledgeIncompleteBackup) {
      return {
        execution: rejected(
          `Delete backup exceeds ${AGENT_LIMITS.maxDeleteBackupBytes} bytes or includes binary/unreadable files (${plan.snapshot.omittedFiles} omitted). Pass acknowledge_incomplete_backup:true to propose anyway; restore will be partial. Excluded: ${
            plan.excluded.map((item) => item.path).join(', ') || '(none)'
          }`
        ),
        operation: null
      }
    }
    const snapshotText = JSON.stringify(plan.snapshot)
    const meta = JSON.stringify({
      deletePlan: {
        targets: plan.targets,
        excluded: plan.excluded,
        fileCount: plan.fileCount,
        dirCount: plan.dirCount,
        totalBytes: plan.totalBytes,
        snapshotComplete: plan.snapshotComplete,
        recursive: args.recursive
      }
    })
    const singleFile =
      plan.targets.length === 1 && plan.targets[0]?.kind === 'file' && plan.snapshotComplete
        ? plan.snapshot.entries.find((entry) => entry.path === plan.targets[0]?.path && entry.type === 'file')
        : null
    const originalText = singleFile?.content != null ? singleFile.content : snapshotText
    const baseHash = contentHash(originalText)
    return persistProposal(input, {
      kind: 'delete',
      path: plan.displayPath.startsWith('(') ? plan.targets[0]!.path : plan.displayPath,
      toPath: null,
      explanation: args.explanation,
      originalText,
      proposedText: meta,
      baseHash,
      diff: formatDeleteDiff(plan)
    })
  } catch (error) {
    return { execution: rejected(mutationErrorMessage(error)), operation: null }
  }
}

function proposeRename(
  input: { root: string; database: MissionDatabase; missionId: string; callId: string },
  fromPath: string,
  toPath: string,
  explanation: string
): ProposeResult {
  const path = normalizeRelative(fromPath)
  const destination = normalizeRelative(toPath)
  if (excludedMutationPath(path) || excludedMutationPath(destination)) {
    return { execution: rejected('That path is excluded from agent edits.'), operation: null }
  }
  const source = resolveEntry(input.root, path)
  const dest = resolveEntry(input.root, destination)
  if (source.lexical === source.root || dest.lexical === dest.root) {
    return { execution: rejected('Refusing to rename the workspace root.'), operation: null }
  }
  if (!source.exists) {
    return { execution: rejected('Path does not exist.'), operation: null }
  }
  if (dest.exists) {
    return { execution: rejected('Destination already exists.'), operation: null }
  }
  const original = readTextIfPresent(input.root, path)
  if (original === null) {
    return { execution: rejected('Only files can be renamed by the agent.'), operation: null }
  }
  return persistProposal(input, {
    kind: 'rename',
    path,
    toPath: destination,
    explanation,
    originalText: original,
    proposedText: original,
    baseHash: contentHash(original),
    diff: unifiedDiff(path, original, original, destination)
  })
}

function proposeRestore(
  input: { root: string; database: MissionDatabase; missionId: string; callId: string; workspacePath: string },
  operationId: string | undefined,
  relativePath: string | undefined,
  explanation: string
): ProposeResult {
  let source: AgentOperationRecord | null = null
  if (operationId) {
    source = input.database.getAgentOperationRecord(operationId)
    if (!source) {
      return { execution: rejected('Operation not found in persisted history.'), operation: null }
    }
  } else if (relativePath) {
    const path = normalizeRelative(relativePath)
    // Path-based restore is limited to the current mission so older scaffolds are not treated as disk state.
    const matches = input.database
      .listAgentOperations(input.missionId)
      .map((item) => input.database.getAgentOperationRecord(item.id))
      .filter((item): item is AgentOperationRecord => {
        if (!item || item.kind === 'restore' || item.status !== 'applied') {
          return false
        }
        return item.path === path || item.toPath === path
      })
      .filter((item) => operationHasSnapshot(input.database, item))
    if (matches.length === 0) {
      return {
        execution: rejected(
          'No applied operation for that path exists in the current mission. History from earlier missions is not live disk state. Use list_files/read_file, or pass an explicit operationId only when the user asked to recover a prior change.'
        ),
        operation: null
      }
    }
    if (matches.length > 1) {
      return {
        execution: finished({
          ok: false,
          ambiguous: true,
          error: 'Multiple applied operations match that path. Ask the user which operationId to restore.',
          matches: matches.map((item) => ({
            operationId: item.id,
            kind: item.kind,
            path: item.path,
            toPath: item.toPath,
            status: item.status,
            createdAt: item.createdAt,
            hasSnapshot: true
          }))
        }),
        operation: null
      }
    }
    source = matches[0]!
  } else {
    return { execution: rejected('Provide operationId or path for restore_file.'), operation: null }
  }
  if (!source || source.status !== 'applied') {
    return { execution: rejected('Only applied operations can be restored.'), operation: null }
  }
  if (source.kind === 'restore') {
    return { execution: rejected('Cannot restore a restore operation.'), operation: null }
  }
  if (source.kind === 'delete' && source.originalText === null) {
    return { execution: rejected('The deletion snapshot is missing. Restore is impossible.'), operation: null }
  }
  if ((source.kind === 'edit' || source.kind === 'rename') && source.originalText === null) {
    return { execution: rejected('The operation snapshot is missing. Restore is impossible.'), operation: null }
  }
  const restorePath = source.kind === 'rename' ? source.path : source.path
  const restoreTo = source.kind === 'rename' ? source.toPath : null
  const before =
    source.kind === 'create' ? source.proposedText : source.kind === 'delete' ? null : source.kind === 'edit' ? source.proposedText : source.proposedText
  const after =
    source.kind === 'create'
      ? null
      : source.kind === 'delete'
        ? source.originalText
        : source.kind === 'edit'
          ? source.originalText
          : source.originalText
  const diff =
    source.kind === 'rename'
      ? unifiedDiff(source.toPath ?? source.path, source.originalText, source.originalText, source.path)
      : unifiedDiff(restorePath, before, after)
  return persistProposal(input, {
    kind: 'restore',
    path: restorePath,
    toPath: restoreTo,
    explanation,
    originalText: source.originalText,
    proposedText: source.proposedText,
    baseHash: source.baseHash,
    diff: `Restore ${source.kind} ${source.path}${source.toPath ? ` → ${source.toPath}` : ''}\n${diff}`,
    sourceOperationId: source.id
  })
}

export function listFileOperations(input: {
  database: MissionDatabase
  workspacePath: string
  missionId?: string
  argumentsText: string
}): ToolExecution {
  const parsed = parseArguments(input.argumentsText)
  if (!parsed.ok) {
    return rejected('Tool arguments were not valid JSON.')
  }
  const args = listOperationsSchema.safeParse(parsed.value)
  if (!args.success) {
    return rejected(argumentError(args.error, 'list_file_operations'))
  }
  const path = args.data.path ? normalizeRelative(args.data.path) : undefined
  const scope = args.data.scope ?? 'current_mission'
  if (scope === 'current_mission' && !input.missionId) {
    return rejected('Current mission scope requires an active mission id.')
  }
  const operations =
    scope === 'current_mission'
      ? input.database
          .listAgentOperations(input.missionId!)
          .filter((item) => {
            if (path && item.path !== path && item.toPath !== path) {
              return false
            }
            if (args.data.kind && item.kind !== args.data.kind) {
              return false
            }
            if (args.data.status && item.status !== args.data.status) {
              return false
            }
            return true
          })
          .slice(0, Math.min(Math.max(args.data.limit ?? 40, 1), 100))
      : input.database.listWorkspaceOperations({
          workspacePath: input.workspacePath,
          path,
          kind: args.data.kind,
          status: args.data.status,
          limit: args.data.limit
        })
  return finished({
    ok: true,
    scope,
    note:
      'These records are persisted operation history. They are not the live filesystem. Use list_files and read_file for disk state. restore_file only reverts current-mission changes.',
    count: operations.length,
    operations: operations.map((item) => {
      const record = input.database.getAgentOperationRecord(item.id)
      return {
        operationId: item.id,
        missionId: item.missionId,
        currentMission: input.missionId ? item.missionId === input.missionId : false,
        kind: item.kind,
        path: item.path,
        toPath: item.toPath,
        status: item.status,
        explanation: item.explanation,
        destructive: item.destructive,
        hasSnapshot: operationHasSnapshot(input.database, record),
        sourceOperationId: item.sourceOperationId,
        createdAt: item.createdAt,
        resolvedAt: item.resolvedAt,
        error: item.error
      }
    })
  })
}

function operationHasSnapshot(database: MissionDatabase, record: AgentOperationRecord | null): boolean {
  if (!record) {
    return false
  }
  if (record.kind === 'delete' || record.kind === 'edit' || record.kind === 'rename') {
    return record.originalText !== null
  }
  if (record.kind === 'create') {
    return record.proposedText !== null
  }
  if (record.kind === 'restore' && record.sourceOperationId) {
    return operationHasSnapshot(database, database.getAgentOperationRecord(record.sourceOperationId))
  }
  return false
}

function persistProposal(
  input: { database: MissionDatabase; missionId: string; callId: string },
  draft: {
    kind: OperationKind
    path: string
    toPath: string | null
    explanation: string
    originalText: string | null
    proposedText: string | null
    baseHash: string | null
    diff: string
    sourceOperationId?: string | null
  }
): ProposeResult {
  const id = crypto.randomUUID()
  const fingerprint = contentFingerprint({
    kind: draft.kind,
    path: draft.path,
    toPath: draft.toPath,
    explanation: draft.explanation,
    originalText: draft.originalText,
    proposedText: draft.proposedText,
    baseHash: draft.baseHash,
    sourceOperationId: draft.sourceOperationId
  })
  const operation = input.database.createAgentOperation({
    id,
    missionId: input.missionId,
    callId: input.callId,
    kind: draft.kind,
    path: draft.path,
    toPath: draft.toPath,
    explanation: draft.explanation,
    originalText: draft.originalText,
    proposedText: draft.proposedText,
    baseHash: draft.baseHash,
    contentFingerprint: fingerprint,
    unifiedDiff: draft.diff,
    sourceOperationId: draft.sourceOperationId ?? null
  })
  const awaitingApproval = operation.kind === 'delete'
  return {
    execution: {
      state: awaitingApproval ? 'awaiting_approval' : 'success',
      output: JSON.stringify({
        ok: true,
        outcome: awaitingApproval ? 'awaiting_approval' : 'success',
        pending: awaitingApproval,
        autoApply: !awaitingApproval,
        operationId: operation.id,
        kind: operation.kind,
        path: operation.path,
        toPath: operation.toPath,
        status: awaitingApproval ? 'pending' : 'proposed',
        contentFingerprint: operation.contentFingerprint,
        destructive: operation.destructive
      })
    },
    operation
  }
}

export type ApplyResult = {
  ok: boolean
  duplicate?: boolean
  operation: AgentOperationSummary
  output: string
}

export function applyClaimedOperation(input: {
  root: string
  database: MissionDatabase
  workspace: WorkspaceService
  record: AgentOperationRecord
  expectedFingerprint: string
}): ApplyResult {
  const record = input.record
  if (record.contentFingerprint !== input.expectedFingerprint) {
    const operation =
      input.database.finalizeAgentOperation(record.id, 'failed', {
        error: 'Proposal content no longer matches the immutable fingerprint.'
      }) ?? summaryFromRecord(record, 'failed', 'Proposal content no longer matches the immutable fingerprint.')
    return {
      ok: false,
      operation,
      output: JSON.stringify({ ok: false, outcome: 'failed', operationId: record.id, error: operation.error, status: operation.status })
    }
  }

  try {
    if (record.kind === 'create') {
      return applyCreate(input, record)
    }
    if (record.kind === 'edit') {
      return applyEdit(input, record)
    }
    if (record.kind === 'delete') {
      return applyDelete(input, record)
    }
    if (record.kind === 'restore') {
      return applyRestore(input, record)
    }
    return applyRename(input, record)
  } catch (error) {
    const message = mutationErrorMessage(error)
    const operation = input.database.finalizeAgentOperation(record.id, 'failed', { error: message }) ?? summaryFromRecord(record, 'failed', message)
    return {
      ok: false,
      operation,
      output: JSON.stringify({ ok: false, outcome: 'failed', operationId: record.id, error: message, status: 'failed' })
    }
  }
}

function applyCreate(
  input: { root: string; database: MissionDatabase; workspace: WorkspaceService },
  record: AgentOperationRecord
): ApplyResult {
  if (record.proposedText === null) {
    throw new AgentError('Create proposal is missing content.')
  }
  const entry = resolveEntry(input.root, record.path)
  if (entry.exists) {
    const operation =
      input.database.finalizeAgentOperation(record.id, 'stale', {
        error: 'The path was created after this proposal.'
      }) ?? summaryFromRecord(record, 'stale', 'The path was created after this proposal.')
    return staleResult(operation)
  }
  input.workspace.createFile(record.path, record.proposedText)
  const appliedHash = contentHash(record.proposedText)
  const operation =
    input.database.finalizeAgentOperation(record.id, 'applied', {
      appliedHash
    }) ?? summaryFromRecord(record, 'applied', null)
  return {
    ok: true,
    operation,
    output: JSON.stringify({
      ok: true,
      outcome: 'success',
      applied: true,
      operationId: record.id,
      kind: 'create',
      path: record.path,
      status: 'applied',
      contentFingerprint: record.contentFingerprint
    })
  }
}

function applyEdit(
  input: { root: string; database: MissionDatabase; workspace: WorkspaceService },
  record: AgentOperationRecord
): ApplyResult {
  if (record.proposedText === null || record.baseHash === null) {
    throw new AgentError('Edit proposal is incomplete.')
  }
  const current = currentHash(input.root, record.path)
  if (current === null) {
    const operation =
      input.database.finalizeAgentOperation(record.id, 'stale', {
        error: 'The file was removed after this proposal.'
      }) ?? summaryFromRecord(record, 'stale', 'The file was removed after this proposal.')
    return staleResult(operation)
  }
  if (current !== record.baseHash) {
    const operation =
      input.database.finalizeAgentOperation(record.id, 'stale', {
        error: 'The file changed after this proposal.'
      }) ?? summaryFromRecord(record, 'stale', 'The file changed after this proposal.')
    return staleResult(operation)
  }
  input.workspace.write(record.path, record.proposedText)
  const appliedHash = contentHash(record.proposedText)
  const operation =
    input.database.finalizeAgentOperation(record.id, 'applied', { appliedHash }) ?? summaryFromRecord(record, 'applied', null)
  return {
    ok: true,
    operation,
    output: JSON.stringify({
      ok: true,
      outcome: 'success',
      applied: true,
      operationId: record.id,
      kind: 'edit',
      path: record.path,
      status: 'applied',
      contentFingerprint: record.contentFingerprint
    })
  }
}

function applyDelete(
  input: { root: string; database: MissionDatabase; workspace: WorkspaceService },
  record: AgentOperationRecord
): ApplyResult {
  if (record.baseHash === null) {
    throw new AgentError('Delete proposal is incomplete.')
  }
  const planMeta = parseDeletePlanMeta(record.proposedText)
  const targets = planMeta?.targets?.map((item) => item.path) ?? [record.path]
  if (!isTreeSnapshot(record.originalText) && targets.length === 1) {
    const current = currentHash(input.root, record.path)
    if (current === null) {
      const operation =
        input.database.finalizeAgentOperation(record.id, 'stale', {
          error: 'The file was already removed.'
        }) ?? summaryFromRecord(record, 'stale', 'The file was already removed.')
      return staleResult(operation)
    }
    if (current !== record.baseHash) {
      const operation =
        input.database.finalizeAgentOperation(record.id, 'stale', {
          error: 'The file changed after this proposal.'
        }) ?? summaryFromRecord(record, 'stale', 'The file changed after this proposal.')
      return staleResult(operation)
    }
    input.workspace.remove(record.path, true)
  } else {
    for (const target of targets) {
      const entry = resolveEntry(input.root, target)
      if (!entry.exists) {
        continue
      }
      input.workspace.remove(target, true)
    }
  }
  const operation =
    input.database.finalizeAgentOperation(record.id, 'applied', { appliedHash: null }) ?? summaryFromRecord(record, 'applied', null)
  return {
    ok: true,
    operation,
    output: JSON.stringify({
      ok: true,
      outcome: 'success',
      applied: true,
      operationId: record.id,
      kind: 'delete',
      path: record.path,
      paths: targets,
      status: 'applied',
      contentFingerprint: record.contentFingerprint,
      destructive: true,
      excluded: planMeta?.excluded ?? [],
      fileCount: planMeta?.fileCount,
      dirCount: planMeta?.dirCount
    })
  }
}

function parseDeletePlanMeta(proposedText: string | null): {
  targets?: Array<{ path: string }>
  excluded?: Array<{ path: string; reason: string }>
  fileCount?: number
  dirCount?: number
} | null {
  if (!proposedText) {
    return null
  }
  try {
    const parsed = JSON.parse(proposedText) as { deletePlan?: Record<string, unknown> }
    const plan = parsed.deletePlan
    if (!plan || typeof plan !== 'object') {
      return null
    }
    return plan as {
      targets?: Array<{ path: string }>
      excluded?: Array<{ path: string; reason: string }>
      fileCount?: number
      dirCount?: number
    }
  } catch {
    return null
  }
}

function applyRename(
  input: { root: string; database: MissionDatabase; workspace: WorkspaceService },
  record: AgentOperationRecord
): ApplyResult {
  if (!record.toPath || record.baseHash === null) {
    throw new AgentError('Rename proposal is incomplete.')
  }
  const current = currentHash(input.root, record.path)
  if (current === null) {
    const operation =
      input.database.finalizeAgentOperation(record.id, 'stale', {
        error: 'The source file was removed after this proposal.'
      }) ?? summaryFromRecord(record, 'stale', 'The source file was removed after this proposal.')
    return staleResult(operation)
  }
  if (current !== record.baseHash) {
    const operation =
      input.database.finalizeAgentOperation(record.id, 'stale', {
        error: 'The source file changed after this proposal.'
      }) ?? summaryFromRecord(record, 'stale', 'The source file changed after this proposal.')
    return staleResult(operation)
  }
  const dest = resolveEntry(input.root, record.toPath)
  if (dest.exists) {
    const operation =
      input.database.finalizeAgentOperation(record.id, 'stale', {
        error: 'The destination was created after this proposal.'
      }) ?? summaryFromRecord(record, 'stale', 'The destination was created after this proposal.')
    return staleResult(operation)
  }
  input.workspace.rename(record.path, record.toPath, true)
  const appliedHash = contentHash(record.originalText ?? '')
  const operation =
    input.database.finalizeAgentOperation(record.id, 'applied', { appliedHash }) ?? summaryFromRecord(record, 'applied', null)
  return {
    ok: true,
    operation,
    output: JSON.stringify({
      ok: true,
      outcome: 'success',
      applied: true,
      operationId: record.id,
      kind: 'rename',
      path: record.path,
      toPath: record.toPath,
      status: 'applied',
      contentFingerprint: record.contentFingerprint,
      destructive: true
    })
  }
}

function applyRestore(
  input: { root: string; database: MissionDatabase; workspace: WorkspaceService },
  record: AgentOperationRecord
): ApplyResult {
  if (!record.sourceOperationId) {
    throw new AgentError('Restore proposal is missing the source operation.')
  }
  const source = input.database.getAgentOperationRecord(record.sourceOperationId)
  if (!source || source.status !== 'applied') {
    const operation =
      input.database.finalizeAgentOperation(record.id, 'failed', {
        error: 'The source operation is no longer applied or was not found.'
      }) ?? summaryFromRecord(record, 'failed', 'The source operation is no longer applied or was not found.')
    return {
      ok: false,
      operation,
      output: JSON.stringify({ ok: false, outcome: 'failed', operationId: record.id, error: operation.error, status: 'failed' })
    }
  }
  restoreOperation({
    root: input.root,
    database: input.database,
    workspace: input.workspace,
    operationId: source.id
  })
  const operation =
    input.database.finalizeAgentOperation(record.id, 'applied', {
      appliedHash: source.kind === 'delete' ? contentHash(source.originalText ?? '') : source.baseHash
    }) ?? summaryFromRecord(record, 'applied', null)
  return {
    ok: true,
    operation,
    output: JSON.stringify({
      ok: true,
      outcome: 'success',
      applied: true,
      restored: true,
      operationId: record.id,
      sourceOperationId: source.id,
      kind: 'restore',
      path: record.path,
      status: 'applied',
      contentFingerprint: record.contentFingerprint
    })
  }
}

function staleResult(operation: AgentOperationSummary): ApplyResult {
  return {
    ok: false,
    operation,
    output: JSON.stringify({
      ok: false,
      operationId: operation.id,
      error: operation.error,
      status: 'stale'
    })
  }
}

function summaryFromRecord(
  record: AgentOperationRecord,
  status: AgentOperationSummary['status'],
  error: string | null
): AgentOperationSummary {
  return {
    id: record.id,
    missionId: record.missionId,
    callId: record.callId,
    kind: record.kind,
    path: record.path,
    toPath: record.toPath,
    explanation: record.explanation,
    status,
    unifiedDiff: record.unifiedDiff,
    destructive: record.destructive,
    error,
    contentFingerprint: record.contentFingerprint,
    sourceOperationId: record.sourceOperationId,
    createdAt: record.createdAt,
    resolvedAt: record.resolvedAt
  }
}

export function restoreOperation(input: {
  root: string
  database: MissionDatabase
  workspace: WorkspaceService
  operationId: string
}): { restored: true } | never {
  const record = input.database.getAgentOperationRecord(input.operationId)
  if (!record) {
    throw new AgentError('Operation not found.')
  }
  if (record.status !== 'applied') {
    throw new AgentError('Only applied operations can be restored.')
  }
  if (record.kind === 'create') {
    if (record.appliedHash) {
      const current = currentHash(input.root, record.path)
      if (current !== record.appliedHash) {
        throw new AgentError('The file changed after this operation. Restore refused.')
      }
    }
    input.workspace.remove(record.path, true)
    return { restored: true }
  }
  if (record.kind === 'edit') {
    if (record.originalText === null || !record.appliedHash) {
      throw new AgentError('Restore snapshot is incomplete.')
    }
    const current = currentHash(input.root, record.path)
    if (current !== record.appliedHash) {
      throw new AgentError('The file changed after this operation. Restore refused.')
    }
    input.workspace.write(record.path, record.originalText)
    return { restored: true }
  }
  if (record.kind === 'delete') {
    if (record.originalText === null) {
      throw new AgentError('Restore snapshot is incomplete.')
    }
    if (isTreeSnapshot(record.originalText)) {
      const snapshot = parseDeleteSnapshot(record.originalText)
      restoreTreeSnapshot({
        root: input.root,
        snapshot,
        createFile: (relativePath, content) => input.workspace.createFile(relativePath, content),
        ensureDir: (relativePath) => {
          const entry = resolveEntry(input.root, relativePath)
          if (!entry.exists) {
            fs.mkdirSync(entry.lexical, { recursive: true })
          }
        }
      })
      return { restored: true }
    }
    const entry = resolveEntry(input.root, record.path)
    if (entry.exists) {
      throw new AgentError('A file exists at the restore path. Restore refused.')
    }
    input.workspace.createFile(record.path, record.originalText)
    return { restored: true }
  }
  if (!record.toPath || record.originalText === null) {
    throw new AgentError('Restore snapshot is incomplete.')
  }
  const current = currentHash(input.root, record.toPath)
  if (record.appliedHash && current !== record.appliedHash) {
    throw new AgentError('The renamed file changed after this operation. Restore refused.')
  }
  if (current === null) {
    throw new AgentError('The renamed file is missing. Restore refused.')
  }
  const sourceBack = resolveEntry(input.root, record.path)
  if (sourceBack.exists) {
    throw new AgentError('The original path is occupied. Restore refused.')
  }
  input.workspace.rename(record.toPath, record.path, true)
  return { restored: true }
}

export function proposalEventPayload(operation: AgentOperationSummary): {
  id: string
  kind: OperationKind
  path: string
  toPath: string | null
  explanation: string
  status: AgentOperationSummary['status']
  unifiedDiff: string
  destructive: boolean
  error: string | null
  contentFingerprint: string
} {
  return {
    id: operation.id,
    kind: operation.kind,
    path: operation.path,
    toPath: operation.toPath,
    explanation: operation.explanation,
    status: operation.status,
    unifiedDiff: operation.unifiedDiff.slice(0, 16_000),
    destructive: operation.destructive,
    error: operation.error,
    contentFingerprint: operation.contentFingerprint
  }
}
