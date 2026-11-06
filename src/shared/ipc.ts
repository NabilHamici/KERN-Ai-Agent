import { z } from 'zod'

const invalid = { error: 'Invalid request' } as const

export const relativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), invalid)

export const emptyRequestSchema = z.strictObject({})

export const workspaceReadSchema = z.strictObject({
  path: relativePathSchema
})

export const workspaceListSchema = z.strictObject({
  path: relativePathSchema
})

export const workspaceWriteSchema = z.strictObject({
  path: relativePathSchema,
  content: z.string().max(5_000_000)
})

export const workspaceCreateFileSchema = z.strictObject({
  path: relativePathSchema,
  content: z.string().max(5_000_000).optional()
})

export const workspaceCreateDirectorySchema = z.strictObject({
  path: relativePathSchema
})

export const workspaceRenameSchema = z.strictObject({
  from: relativePathSchema,
  to: relativePathSchema,
  confirm: z.literal(true)
})

export const workspaceRemoveSchema = z.strictObject({
  path: relativePathSchema,
  confirm: z.literal(true)
})

export const secretSetSchema = z.strictObject({
  apiKey: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => value === value.trim() && !/[\r\n]/.test(value), invalid)
})

export const historyQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional()
})

export const terminalWriteSchema = z.strictObject({
  data: z.string().max(65_536)
})

export const terminalResizeSchema = z.strictObject({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300)
})

export const terminalDataSchema = z.strictObject({
  data: z.string()
})

export const terminalExitSchema = z.strictObject({
  exitCode: z.number().int()
})

export const IpcChannel = {
  workspaceSelect: 'workspace:select',
  workspaceCurrent: 'workspace:current',
  workspaceList: 'workspace:list',
  workspaceRead: 'workspace:read',
  workspaceWrite: 'workspace:write',
  workspaceCreateFile: 'workspace:createFile',
  workspaceCreateDirectory: 'workspace:createDirectory',
  workspaceRename: 'workspace:rename',
  workspaceRemove: 'workspace:remove',
  secretsStatus: 'secrets:status',
  secretsSet: 'secrets:set',
  secretsClear: 'secrets:clear',
  terminalStart: 'terminal:start',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalCancel: 'terminal:cancel',
  historyMissions: 'history:missions',
  historyFileChanges: 'history:fileChanges',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit'
} as const

export const requestSchemas = {
  [IpcChannel.workspaceSelect]: emptyRequestSchema,
  [IpcChannel.workspaceCurrent]: emptyRequestSchema,
  [IpcChannel.workspaceList]: workspaceListSchema,
  [IpcChannel.workspaceRead]: workspaceReadSchema,
  [IpcChannel.workspaceWrite]: workspaceWriteSchema,
  [IpcChannel.workspaceCreateFile]: workspaceCreateFileSchema,
  [IpcChannel.workspaceCreateDirectory]: workspaceCreateDirectorySchema,
  [IpcChannel.workspaceRename]: workspaceRenameSchema,
  [IpcChannel.workspaceRemove]: workspaceRemoveSchema,
  [IpcChannel.secretsStatus]: emptyRequestSchema,
  [IpcChannel.secretsSet]: secretSetSchema,
  [IpcChannel.secretsClear]: emptyRequestSchema,
  [IpcChannel.terminalStart]: emptyRequestSchema,
  [IpcChannel.terminalWrite]: terminalWriteSchema,
  [IpcChannel.terminalResize]: terminalResizeSchema,
  [IpcChannel.terminalCancel]: emptyRequestSchema,
  [IpcChannel.historyMissions]: historyQuerySchema,
  [IpcChannel.historyFileChanges]: historyQuerySchema
} as const

export type RequestChannel = keyof typeof requestSchemas

export type IpcSuccess<T> = { ok: true; data: T }
export type IpcFailure = { ok: false; error: string }
export type IpcResult<T> = IpcSuccess<T> | IpcFailure

export function parseRequest(channel: string, payload: unknown): IpcResult<unknown> {
  const schema = requestSchemas[channel as RequestChannel]
  if (!schema) {
    return { ok: false, error: 'Invalid request' }
  }
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    return { ok: false, error: 'Invalid request' }
  }
  return { ok: true, data: parsed.data }
}

export type DirectoryEntry = {
  name: string
  relativePath: string
  kind: 'file' | 'directory'
  blocked: boolean
}

export type WorkspaceInfo = {
  path: string
  name: string
}

export type MissionRecord = {
  id: string
  workspacePath: string
  title: string
  status: string
  createdAt: string
  updatedAt: string
}

export type FileChangeRecord = {
  id: string
  missionId: string | null
  relativePath: string
  changeType: string
  createdAt: string
  hasReverse: boolean
}

export type SecretStatus = {
  configured: boolean
  storageAvailable: boolean
}
