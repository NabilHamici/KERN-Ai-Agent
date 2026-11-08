import { z } from 'zod'
import {
  agentApproveSchema,
  agentCancelSchema,
  agentEventSchema,
  agentRejectSchema,
  agentRestoreSchema,
  agentSubmitSchema,
  chatArchiveSchema,
  chatCreateSchema,
  chatGetSchema,
  chatListSchema,
  chatRenameSchema
} from './agent.ts'
import {
  authEmailSchema,
  authLoginSchema,
  authRegisterSchema,
  authResetSchema,
  authVerifySchema
} from './auth.ts'
import { providerSetSchema } from './provider.ts'
import {
  gitAddRemoteRequestSchema,
  gitBranchRequestSchema,
  gitCommitRequestSchema,
  gitDiffRequestSchema,
  gitIdentitySetSchema,
  gitLogRequestSchema,
  gitPullRequestSchema,
  gitPushRequestSchema,
  gitSwitchBranchRequestSchema
} from './git.ts'
import { metricsSubscribeSchema } from './metrics.ts'
import { workspaceChangedEventSchema } from './workspaceEvents.ts'

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

export const historyFileChangesQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  status: z.enum(['open', 'kept', 'undone', 'all']).optional(),
  chatId: z
    .string()
    .min(36)
    .max(36)
    .refine((value) => /^[0-9a-f-]{36}$/i.test(value), invalid)
    .nullable()
    .optional()
})

export const historyKeepFileChangesSchema = z.strictObject({
  ids: z.array(z.string().min(36).max(36)).max(200).optional()
})

export const historyUndoFileChangesSchema = z.strictObject({
  ids: z.array(z.string().min(36).max(36)).max(200).optional(),
  confirm: z.literal(true)
})

export const historyFileChangeReviewSchema = z.strictObject({
  id: z.string().min(36).max(36)
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

export const gitStageRequestSchema = z.strictObject({
  paths: z.union([z.literal('all'), z.array(z.string().min(1).max(4096)).min(1).max(500)])
})

export const gitExportRequestSchema = z.strictObject({
  includeGit: z.boolean().optional(),
  destination: z.string().min(1).max(4096).optional()
})

export const gitIgnorePreviewSchema = z.strictObject({
  stack: z.enum(['node', 'expo', 'react-native']).optional()
})

export const gitIgnoreWriteSchema = z.strictObject({
  content: z.string().min(1).max(100_000),
  confirm: z.literal(true)
})

export const gitScanCommitSchema = z.strictObject({
  paths: z.array(z.string().min(1).max(4096)).max(5_000).optional()
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
  secretsSetCursor: 'secrets:setCursor',
  secretsClearCursor: 'secrets:clearCursor',
  providerGet: 'provider:get',
  providerSet: 'provider:set',
  providerCheck: 'provider:check',
  terminalStart: 'terminal:start',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalCancel: 'terminal:cancel',
  historyMissions: 'history:missions',
  historyFileChanges: 'history:fileChanges',
  historyKeepFileChanges: 'history:keepFileChanges',
  historyUndoFileChanges: 'history:undoFileChanges',
  historyFileChangeReview: 'history:fileChangeReview',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  agentSubmit: 'agent:submit',
  agentCancel: 'agent:cancel',
  agentApprove: 'agent:approve',
  agentReject: 'agent:reject',
  agentRestore: 'agent:restore',
  agentCurrent: 'agent:current',
  agentHistory: 'agent:history',
  agentTranscript: 'agent:transcript',
  agentEvent: 'agent:event',
  chatList: 'chat:list',
  chatCreate: 'chat:create',
  chatGet: 'chat:get',
  chatSelect: 'chat:select',
  chatRename: 'chat:rename',
  chatArchive: 'chat:archive',
  chatHydrate: 'chat:hydrate',
  authStatus: 'auth:status',
  authRegister: 'auth:register',
  authLogin: 'auth:login',
  authVerify: 'auth:verify',
  authResend: 'auth:resend',
  authForgot: 'auth:forgot',
  authReset: 'auth:reset',
  authLogout: 'auth:logout',
  authLogoutAll: 'auth:logoutAll',
  authMe: 'auth:me',
  authDevices: 'auth:devices',
  authRetry: 'auth:retry',
  metricsSubscribe: 'metrics:subscribe',
  metricsUnsubscribe: 'metrics:unsubscribe',
  metricsSample: 'metrics:sample',
  workspaceChanged: 'workspace:changed',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitLog: 'git:log',
  gitInit: 'git:init',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitCommit: 'git:commit',
  gitCreateBranch: 'git:createBranch',
  gitSwitch: 'git:switch',
  gitAddRemote: 'git:addRemote',
  gitPush: 'git:push',
  gitPull: 'git:pull',
  gitIdentity: 'git:identity',
  gitSetIdentity: 'git:setIdentity',
  gitIgnorePreview: 'git:ignorePreview',
  gitIgnoreWrite: 'git:ignoreWrite',
  gitScanCommit: 'git:scanCommit',
  gitExportPreview: 'git:exportPreview',
  gitExport: 'git:export',
  gitPublishProbe: 'git:publishProbe'
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
  [IpcChannel.secretsSetCursor]: secretSetSchema,
  [IpcChannel.secretsClearCursor]: emptyRequestSchema,
  [IpcChannel.providerGet]: emptyRequestSchema,
  [IpcChannel.providerSet]: providerSetSchema,
  [IpcChannel.providerCheck]: emptyRequestSchema,
  [IpcChannel.terminalStart]: emptyRequestSchema,
  [IpcChannel.terminalWrite]: terminalWriteSchema,
  [IpcChannel.terminalResize]: terminalResizeSchema,
  [IpcChannel.terminalCancel]: emptyRequestSchema,
  [IpcChannel.historyMissions]: historyQuerySchema,
  [IpcChannel.historyFileChanges]: historyFileChangesQuerySchema,
  [IpcChannel.historyKeepFileChanges]: historyKeepFileChangesSchema,
  [IpcChannel.historyUndoFileChanges]: historyUndoFileChangesSchema,
  [IpcChannel.historyFileChangeReview]: historyFileChangeReviewSchema,
  [IpcChannel.agentSubmit]: agentSubmitSchema,
  [IpcChannel.agentCancel]: agentCancelSchema,
  [IpcChannel.agentApprove]: agentApproveSchema,
  [IpcChannel.agentReject]: agentRejectSchema,
  [IpcChannel.agentRestore]: agentRestoreSchema,
  [IpcChannel.agentCurrent]: emptyRequestSchema,
  [IpcChannel.agentHistory]: historyQuerySchema,
  [IpcChannel.agentTranscript]: agentCancelSchema,
  [IpcChannel.chatList]: chatListSchema,
  [IpcChannel.chatCreate]: chatCreateSchema,
  [IpcChannel.chatGet]: chatGetSchema,
  [IpcChannel.chatSelect]: chatGetSchema,
  [IpcChannel.chatRename]: chatRenameSchema,
  [IpcChannel.chatArchive]: chatArchiveSchema,
  [IpcChannel.chatHydrate]: emptyRequestSchema,
  [IpcChannel.authStatus]: emptyRequestSchema,
  [IpcChannel.authRegister]: authRegisterSchema,
  [IpcChannel.authLogin]: authLoginSchema,
  [IpcChannel.authVerify]: authVerifySchema,
  [IpcChannel.authResend]: authEmailSchema,
  [IpcChannel.authForgot]: authEmailSchema,
  [IpcChannel.authReset]: authResetSchema,
  [IpcChannel.authLogout]: emptyRequestSchema,
  [IpcChannel.authLogoutAll]: emptyRequestSchema,
  [IpcChannel.authMe]: emptyRequestSchema,
  [IpcChannel.authDevices]: emptyRequestSchema,
  [IpcChannel.authRetry]: emptyRequestSchema,
  [IpcChannel.metricsSubscribe]: metricsSubscribeSchema,
  [IpcChannel.metricsUnsubscribe]: emptyRequestSchema,
  [IpcChannel.gitStatus]: emptyRequestSchema,
  [IpcChannel.gitDiff]: gitDiffRequestSchema,
  [IpcChannel.gitLog]: gitLogRequestSchema,
  [IpcChannel.gitInit]: emptyRequestSchema,
  [IpcChannel.gitStage]: gitStageRequestSchema,
  [IpcChannel.gitUnstage]: gitStageRequestSchema,
  [IpcChannel.gitCommit]: gitCommitRequestSchema,
  [IpcChannel.gitCreateBranch]: gitBranchRequestSchema,
  [IpcChannel.gitSwitch]: gitSwitchBranchRequestSchema,
  [IpcChannel.gitAddRemote]: gitAddRemoteRequestSchema,
  [IpcChannel.gitPush]: gitPushRequestSchema,
  [IpcChannel.gitPull]: gitPullRequestSchema,
  [IpcChannel.gitIdentity]: emptyRequestSchema,
  [IpcChannel.gitSetIdentity]: gitIdentitySetSchema,
  [IpcChannel.gitIgnorePreview]: gitIgnorePreviewSchema,
  [IpcChannel.gitIgnoreWrite]: gitIgnoreWriteSchema,
  [IpcChannel.gitScanCommit]: gitScanCommitSchema,
  [IpcChannel.gitExportPreview]: z.strictObject({ includeGit: z.boolean().optional() }),
  [IpcChannel.gitExport]: gitExportRequestSchema,
  [IpcChannel.gitPublishProbe]: emptyRequestSchema
} as const

/** Push-only channels (not invoke/request). */
export const pushEventChannels = [IpcChannel.workspaceChanged, IpcChannel.metricsSample, IpcChannel.agentEvent, IpcChannel.terminalData, IpcChannel.terminalExit] as const

export { workspaceChangedEventSchema, metricsSubscribeSchema }
export type { WorkspaceChangedEvent } from './workspaceEvents.ts'
export type { MetricsSample } from './metrics.ts'

const PUBLIC_AUTH_CHANNELS = new Set<RequestChannel>([
  IpcChannel.authStatus,
  IpcChannel.authRegister,
  IpcChannel.authLogin,
  IpcChannel.authVerify,
  IpcChannel.authResend,
  IpcChannel.authForgot,
  IpcChannel.authReset,
  IpcChannel.authRetry
])

export function isPublicAuthChannel(channel: RequestChannel): boolean {
  return PUBLIC_AUTH_CHANNELS.has(channel)
}

export { agentEventSchema }

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

export const FILE_CHANGE_REVIEW_STATUSES = ['open', 'kept', 'undone'] as const

export type FileChangeReviewStatus = (typeof FILE_CHANGE_REVIEW_STATUSES)[number]

export type FileChangeRecord = {
  id: string
  missionId: string | null
  chatId: string | null
  relativePath: string
  changeType: string
  createdAt: string
  hasReverse: boolean
  reviewStatus: FileChangeReviewStatus
}

export type FileChangeReviewItem = {
  id: string
  relativePath: string
  changeType: string
  reviewStatus: FileChangeReviewStatus
  hasReverse: boolean
  unifiedDiff: string
  error: string | null
}

export type SecretStatus = {
  configured: boolean
  cursorConfigured: boolean
  storageAvailable: boolean
}
