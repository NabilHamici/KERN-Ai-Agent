import crypto from 'node:crypto'
import fs from 'node:fs'
import { z, type ZodError } from 'zod'
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
import type { ToolExecution } from './tools.ts'

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.pnpm-store', 'coverage'])

const createSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  content: z.string().max(AGENT_LIMITS.maxProposalChars),
  explanation: z.string().min(1).max(500)
})

const editSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  content: z.string().max(AGENT_LIMITS.maxProposalChars),
  explanation: z.string().min(1).max(500)
})

const deleteSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  explanation: z.string().min(1).max(500)
})

const renameSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  to: z.string().min(1).max(4096),
  explanation: z.string().min(1).max(500)
})

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
}): string {
  return contentHash(
    JSON.stringify({
      kind: parts.kind,
      path: parts.path,
      toPath: parts.toPath,
      explanation: parts.explanation,
      originalText: parts.originalText,
      proposedText: parts.proposedText,
      baseHash: parts.baseHash
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
  return { state: 'rejected', output: JSON.stringify({ ok: false, error }) }
}

function finished(payload: unknown): ToolExecution {
  const output = JSON.stringify(payload)
  if (output.length <= AGENT_LIMITS.maxToolOutputChars) {
    return { state: 'finished', output }
  }
  return { state: 'finished', output: `${output.slice(0, AGENT_LIMITS.maxToolOutputChars)}\n[output truncated]` }
}

function argumentError(error: ZodError): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const field = issue.path.length > 0 ? issue.path.map(String).join('.') : 'arguments'
    if (issue.code === 'unrecognized_keys' && 'keys' in issue && Array.isArray(issue.keys)) {
      return `${field}: unrecognized key ${issue.keys.join(', ')}. Only documented fields are accepted.`
    }
    return `${field}: ${issue.message}`
  })
  return `Tool arguments were rejected. ${parts.join(' ')}`
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
        return { execution: rejected(argumentError(args.error)), operation: null }
      }
      return proposeCreate(input, args.data.path, args.data.content, args.data.explanation)
    }
    if (input.name === 'edit_file') {
      const args = editSchema.safeParse(parsed.value)
      if (!args.success) {
        return { execution: rejected(argumentError(args.error)), operation: null }
      }
      return proposeEdit(input, args.data.path, args.data.content, args.data.explanation)
    }
    if (input.name === 'delete_file') {
      const args = deleteSchema.safeParse(parsed.value)
      if (!args.success) {
        return { execution: rejected(argumentError(args.error)), operation: null }
      }
      return proposeDelete(input, args.data.path, args.data.explanation)
    }
    const args = renameSchema.safeParse(parsed.value)
    if (!args.success) {
      return { execution: rejected(argumentError(args.error)), operation: null }
    }
    return proposeRename(input, args.data.path, args.data.to, args.data.explanation)
  } catch (error) {
    if (error instanceof PathJailError) {
      return { execution: rejected(error.message), operation: null }
    }
    return { execution: rejected('Tool failed.'), operation: null }
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
    return { execution: rejected('Path already exists.'), operation: null }
  }
  // Ensure parent stays inside the jail once created.
  resolveEntry(input.root, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '.' : '.')
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
  relativePath: string,
  explanation: string
): ProposeResult {
  const path = normalizeRelative(relativePath)
  if (excludedMutationPath(path)) {
    return { execution: rejected('That path is excluded from agent edits.'), operation: null }
  }
  const entry = resolveEntry(input.root, path)
  if (entry.lexical === entry.root) {
    return { execution: rejected('Refusing to delete the workspace root.'), operation: null }
  }
  const original = readTextIfPresent(input.root, path)
  if (original === null) {
    return { execution: rejected('Path does not exist.'), operation: null }
  }
  return persistProposal(input, {
    kind: 'delete',
    path,
    toPath: null,
    explanation,
    originalText: original,
    proposedText: null,
    baseHash: contentHash(original),
    diff: unifiedDiff(path, original, null)
  })
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
    baseHash: draft.baseHash
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
    unifiedDiff: draft.diff
  })
  return {
    execution: finished({
      ok: true,
      pending: true,
      operationId: operation.id,
      kind: operation.kind,
      path: operation.path,
      toPath: operation.toPath,
      status: 'pending',
      contentFingerprint: operation.contentFingerprint,
      destructive: operation.destructive
    }),
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
      output: JSON.stringify({ ok: false, operationId: record.id, error: operation.error, status: operation.status })
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
    return applyRename(input, record)
  } catch (error) {
    const message = error instanceof PathJailError || error instanceof AgentError ? error.message : 'Apply failed.'
    const operation = input.database.finalizeAgentOperation(record.id, 'failed', { error: message }) ?? summaryFromRecord(record, 'failed', message)
    return {
      ok: false,
      operation,
      output: JSON.stringify({ ok: false, operationId: record.id, error: message, status: 'failed' })
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
  const operation =
    input.database.finalizeAgentOperation(record.id, 'applied', { appliedHash: null }) ?? summaryFromRecord(record, 'applied', null)
  return {
    ok: true,
    operation,
    output: JSON.stringify({
      ok: true,
      applied: true,
      operationId: record.id,
      kind: 'delete',
      path: record.path,
      status: 'applied',
      contentFingerprint: record.contentFingerprint,
      destructive: true
    })
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
