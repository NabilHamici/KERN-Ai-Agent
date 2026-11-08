import {
  AgentError,
  isTerminalStatus,
  isMutationTool,
  mutationRequiresApproval,
  redactSensitive,
  type AgentChatSummary,
  type AgentChatTranscript,
  type AgentEvent,
  type AgentMissionSummary,
  type AgentOperationSummary,
  type AgentTranscript,
  type MissionStatus
} from '../../shared/agent.ts'
import type { ProviderId } from '../../shared/provider.ts'
import type { MissionDatabase } from '../services/database.ts'
import type { WorkspaceService } from '../services/workspace.ts'
import { runAgentLoop, type ModelClient } from './loop.ts'
import {
  applyClaimedOperation,
  listFileOperations,
  proposeMutation,
  proposalEventPayload,
  restoreOperation
} from './mutations.ts'
import { requestBharatCode, type ProviderTurn } from './provider.ts'
import { runBrokerCommand } from './commands.ts'
import { executeTool } from './tools.ts'
import type { FunctionCall } from './provider.ts'
import type { ToolExecution } from './tools.ts'

type WorkspaceSnapshot = { path: string; name: string }

type ApprovalWaiter = {
  missionId: string
  operationIds: Set<string>
  results: Map<string, { callId: string; execution: ToolExecution }>
  resolve: (value: Array<{ callId: string; execution: ToolExecution }>) => void
  reject: (error: Error) => void
}

export class AgentRuntime {
  private busy = false
  private tail: Promise<void> = Promise.resolve()
  private readonly controllers = new Map<string, AbortController>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly waiters = new Map<string, ApprovalWaiter>()
  private readonly database: MissionDatabase
  private readonly workspace: WorkspaceService
  private readonly currentWorkspace: () => WorkspaceSnapshot | null
  private readonly readApiKey: () => Promise<string | null>
  private readonly cursorReady: () => Promise<boolean>
  private readonly readProvider: () => ProviderId
  private readonly emit: (event: AgentEvent) => void
  private readonly client: ModelClient
  private readonly onCommandSpawn: ((pid: number) => void) | null
  private readonly onCommandFinished: ((cwdRelative: string) => void) | null
  private readonly onMutationApplied: ((paths: string[]) => void) | null
  private readonly onStreamChars: ((chars: number) => void) | null
  private readonly onTokenUsage: ((usage: { input?: number; output?: number; model?: string | null }) => void) | null

  constructor(options: {
    database: MissionDatabase
    workspace: WorkspaceService
    currentWorkspace?: () => WorkspaceSnapshot | null
    readApiKey: () => Promise<string | null>
    cursorReady?: () => Promise<boolean>
    readProvider?: () => ProviderId
    emit: (event: AgentEvent) => void
    client?: ModelClient
    onCommandSpawn?: (pid: number) => void
    onCommandFinished?: (cwdRelative: string) => void
    onMutationApplied?: (paths: string[]) => void
    onStreamChars?: (chars: number) => void
    onTokenUsage?: (usage: { input?: number; output?: number; model?: string | null }) => void
  }) {
    this.database = options.database
    this.workspace = options.workspace
    this.currentWorkspace = options.currentWorkspace ?? (() => options.workspace.current())
    this.readApiKey = options.readApiKey
    this.cursorReady = options.cursorReady ?? (async () => false)
    this.readProvider = options.readProvider ?? (() => 'bharatcode')
    this.emit = options.emit
    this.onCommandSpawn = options.onCommandSpawn ?? null
    this.onCommandFinished = options.onCommandFinished ?? null
    this.onMutationApplied = options.onMutationApplied ?? null
    this.onStreamChars = options.onStreamChars ?? null
    this.onTokenUsage = options.onTokenUsage ?? null
    this.client =
      options.client ??
      (async (input): Promise<ProviderTurn> => {
        const key = await this.readApiKey()
        if (!key) {
          return { kind: 'failed', message: 'No BharatCode API key is stored.', requestId: null }
        }
        return requestBharatCode({
          apiKey: key,
          instructions: input.instructions,
          input: input.input,
          tools: input.tools,
          signal: input.signal,
          onDelta: input.onDelta
        })
      })
    this.database.interruptAgentMissions()
  }

  async submit(
    prompt: string,
    continueFromMissionId?: string,
    chatId?: string
  ): Promise<{ missionId: string; chatId: string }> {
    if (this.busy) {
      throw new AgentError('A mission is already running')
    }
    const workspace = this.currentWorkspace()
    if (!workspace) {
      throw new AgentError('No workspace is open')
    }
    this.busy = true
    try {
      const provider = this.readProvider()
      const key = provider === 'cursor' ? '' : await this.readApiKey()
      if (provider === 'cursor') {
        const envKey = process.env.CURSOR_API_KEY?.trim()
        if (!envKey && !(await this.cursorReady())) {
          this.busy = false
          throw new AgentError('Cursor is not signed in on this Mac.')
        }
      } else if (!key) {
        this.busy = false
        throw new AgentError('No BharatCode API key is stored')
      }
      const resolvedChatId = this.resolveChatId(workspace.path, chatId, continueFromMissionId)
      this.workspace.setActiveChatId(resolvedChatId)
      this.database.setSelectedChatId(workspace.path, resolvedChatId)
      const priorContext = this.priorChatContext(resolvedChatId, workspace.path, continueFromMissionId)
      const mission = this.database.createAgentMission(workspace.path, prompt, resolvedChatId)
      const controller = new AbortController()
      this.controllers.set(mission.id, controller)
      this.publish({ type: 'status', missionId: mission.id, status: 'queued', title: mission.title })
      this.tail = this.execute(mission.id, workspace, key ?? '', controller, priorContext)
      return { missionId: mission.id, chatId: resolvedChatId }
    } catch (error) {
      this.busy = false
      throw error
    }
  }

  cancel(missionId: string): { cancelled: boolean } {
    const controller = this.controllers.get(missionId)
    if (!controller) {
      return { cancelled: false }
    }
    void this.withMissionLock(missionId, async () => {
      this.database.cancelPendingAgentOperations(missionId)
      const waiter = this.waiters.get(missionId)
      if (waiter) {
        for (const operationId of [...waiter.operationIds]) {
          const operation = this.database.getAgentOperation(operationId)
          if (!operation) {
            continue
          }
          this.publishProposal(operation)
          if (!waiter.results.has(operation.callId)) {
            waiter.results.set(operation.callId, {
              callId: operation.callId,
              execution: {
                state: 'rejected',
                output: JSON.stringify({
                  ok: false,
                  operationId,
                  status: 'cancelled',
                  error: 'The mission was cancelled.'
                })
              }
            })
          }
        }
        this.settleWaiter(missionId)
      }
      this.finish(missionId, 'cancelled', null, 'The mission was cancelled.')
      controller.abort()
    })
    return { cancelled: true }
  }

  stopAll(): void {
    for (const missionId of [...this.controllers.keys()]) {
      this.cancel(missionId)
    }
  }

  finished(): Promise<void> {
    return this.tail
  }

  history(limit?: number): AgentMissionSummary[] {
    return this.database.listAgentMissions(limit ?? 20)
  }

  transcript(missionId: string): AgentTranscript | null {
    return this.database.agentTranscript(missionId)
  }

  current(): AgentTranscript | null {
    const active = this.database.activeAgentMission()
    if (!active) {
      return null
    }
    return this.database.agentTranscript(active.id)
  }

  /** Active mission if any, otherwise the latest mission for the open workspace. */
  hydrate(): AgentTranscript | null {
    const chat = this.hydrateChat()
    if (!chat || chat.turns.length === 0) {
      return this.current()
    }
    return chat.turns[chat.turns.length - 1] ?? null
  }

  hydrateChat(): AgentChatTranscript | null {
    const workspace = this.currentWorkspace()
    if (!workspace) {
      return null
    }
    const selectedId = this.database.getSelectedChatId(workspace.path)
    let chat = selectedId && this.database.agentChatBelongsToWorkspace(selectedId, workspace.path)
      ? this.database.getAgentChat(selectedId)
      : null
    if (chat?.archivedAt) {
      chat = null
    }
    if (!chat) {
      chat = this.database.latestAgentChat(workspace.path)
    }
    if (!chat) {
      return null
    }
    this.workspace.setActiveChatId(chat.id)
    this.database.setSelectedChatId(workspace.path, chat.id)
    return this.database.agentChatTranscript(chat.id)
  }

  listChats(limit?: number): AgentChatSummary[] {
    const workspace = this.currentWorkspace()
    if (!workspace) {
      return []
    }
    return this.database.listAgentChatsForWorkspace(workspace.path, limit ?? 40)
  }

  createChat(): AgentChatSummary {
    const workspace = this.currentWorkspace()
    if (!workspace) {
      throw new AgentError('No workspace is open')
    }
    if (this.busy) {
      throw new AgentError('A mission is already running')
    }
    const chat = this.database.createAgentChat(workspace.path, 'New chat')
    this.workspace.setActiveChatId(chat.id)
    this.database.setSelectedChatId(workspace.path, chat.id)
    return chat
  }

  isBusy(): boolean {
    return this.busy
  }

  selectChat(chatId: string): AgentChatTranscript {
    const workspace = this.currentWorkspace()
    if (!workspace) {
      throw new AgentError('No workspace is open')
    }
    if (this.busy) {
      const active = this.database.activeAgentMission()
      if (active && active.chatId !== chatId) {
        throw new AgentError('Cannot switch chats while a mission is running.')
      }
    }
    if (!this.database.agentChatBelongsToWorkspace(chatId, workspace.path)) {
      throw new AgentError('Chat does not belong to this workspace.')
    }
    const transcript = this.database.agentChatTranscript(chatId)
    if (!transcript || transcript.chat.archivedAt) {
      throw new AgentError('Chat not found.')
    }
    this.workspace.setActiveChatId(chatId)
    this.database.setSelectedChatId(workspace.path, chatId)
    return transcript
  }

  renameChat(chatId: string, title: string): AgentChatSummary {
    const workspace = this.currentWorkspace()
    if (!workspace) {
      throw new AgentError('No workspace is open')
    }
    if (!this.database.agentChatBelongsToWorkspace(chatId, workspace.path)) {
      throw new AgentError('Chat does not belong to this workspace.')
    }
    const renamed = this.database.renameAgentChat(chatId, title)
    if (!renamed) {
      throw new AgentError('Chat could not be renamed.')
    }
    return renamed
  }

  archiveChat(chatId: string): AgentChatSummary {
    const workspace = this.currentWorkspace()
    if (!workspace) {
      throw new AgentError('No workspace is open')
    }
    if (!this.database.agentChatBelongsToWorkspace(chatId, workspace.path)) {
      throw new AgentError('Chat does not belong to this workspace.')
    }
    if (this.busy) {
      const active = this.database.activeAgentMission()
      if (active?.chatId === chatId) {
        throw new AgentError('Cannot archive a chat while a mission is running.')
      }
    }
    const archived = this.database.archiveAgentChat(chatId)
    if (!archived) {
      throw new AgentError('Chat could not be archived.')
    }
    if (this.workspace.activeChatId() === chatId) {
      const next = this.database.latestAgentChat(workspace.path)
      this.workspace.setActiveChatId(next?.id ?? null)
      this.database.setSelectedChatId(workspace.path, next?.id ?? null)
    }
    return archived
  }

  chatTranscript(chatId: string): AgentChatTranscript | null {
    const workspace = this.currentWorkspace()
    if (!workspace || !this.database.agentChatBelongsToWorkspace(chatId, workspace.path)) {
      return null
    }
    return this.database.agentChatTranscript(chatId)
  }

  historyForWorkspace(limit?: number): AgentMissionSummary[] {
    const workspace = this.currentWorkspace()
    if (!workspace) {
      return this.database.listAgentMissions(limit ?? 20)
    }
    return this.database.listAgentMissionsForWorkspace(workspace.path, limit ?? 20)
  }

  private resolveChatId(workspacePath: string, chatId?: string, continueFromMissionId?: string): string {
    if (chatId) {
      if (!this.database.agentChatBelongsToWorkspace(chatId, workspacePath)) {
        throw new AgentError('Chat does not belong to this workspace.')
      }
      const chat = this.database.getAgentChat(chatId)
      if (!chat || chat.archivedAt) {
        throw new AgentError('Chat not found.')
      }
      return chatId
    }
    if (continueFromMissionId) {
      const prior = this.database.getAgentMission(continueFromMissionId)
      if (prior?.chatId && this.database.agentChatBelongsToWorkspace(prior.chatId, workspacePath)) {
        return prior.chatId
      }
    }
    const selected = this.database.getSelectedChatId(workspacePath)
    if (selected && this.database.agentChatBelongsToWorkspace(selected, workspacePath)) {
      const chat = this.database.getAgentChat(selected)
      if (chat && !chat.archivedAt) {
        return selected
      }
    }
    return this.database.createAgentChat(workspacePath, 'New chat').id
  }

  private priorChatContext(chatId: string, workspacePath: string, continueFromMissionId?: string): string | null {
    if (!this.database.agentChatBelongsToWorkspace(chatId, workspacePath)) {
      return null
    }
    const transcript = this.database.agentChatTranscript(chatId)
    if (!transcript || transcript.turns.length === 0) {
      return continueFromMissionId ? this.priorMissionContext(continueFromMissionId, workspacePath) : null
    }
    const lines: string[] = [
      'Prior conversation context from the current chat (not the live filesystem):',
      `Chat: ${transcript.chat.title}`
    ]
    for (const turn of transcript.turns.slice(-4)) {
      lines.push(`User: ${turn.mission.prompt}`)
      for (const message of turn.messages.slice(0, 4)) {
        if (message.role === 'assistant' || message.role === 'user') {
          const cleaned = compactPriorMessage(message.content)
          if (!cleaned) continue
          const text = cleaned.length > 800 ? `${cleaned.slice(0, 799)}…` : cleaned
          lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
        }
      }
      const ops = turn.operations.slice(-6)
      if (ops.length > 0) {
        lines.push('Persisted file operations from that turn:')
        for (const op of ops) {
          lines.push(`- ${op.status} ${op.kind} ${op.path}${op.toPath ? ` → ${op.toPath}` : ''} id=${op.id}`)
        }
      }
      // Mission-scoped compact facts only — never dump discovered exploration paths.
      if (turn.mission.summary) {
        const summary = compactPriorMessage(turn.mission.summary)
        if (summary) {
          lines.push(`Outcome: ${summary.length > 400 ? `${summary.slice(0, 399)}…` : summary}`)
        }
      }
    }
    lines.push(
      'If the user refers to earlier file changes, call list_file_operations. Do not claim memory of facts that are not in this context or tool results.'
    )
    return lines.join('\n')
  }

  async approve(missionId: string, operationId: string): Promise<{ applied: boolean; duplicate: boolean; status: string }> {
    return this.withMissionLock(missionId, async () => {
      const mission = this.database.getAgentMission(missionId)
      if (!mission) {
        throw new AgentError('Mission not found.')
      }
      if (mission.status !== 'awaiting_approval') {
        throw new AgentError('Mission is not awaiting approval.')
      }
      const existing = this.database.getAgentOperationRecord(operationId)
      if (!existing || existing.missionId !== missionId) {
        throw new AgentError('Operation does not belong to this mission.')
      }
      if (existing.status === 'applied') {
        return { applied: true, duplicate: true, status: 'applied' }
      }
      if (existing.status !== 'pending') {
        throw new AgentError(`Operation is ${existing.status} and cannot be approved.`)
      }
      const claimed = this.database.claimAgentOperation(missionId, operationId)
      if (!claimed) {
        const again = this.database.getAgentOperation(operationId)
        if (again?.status === 'applied') {
          return { applied: true, duplicate: true, status: 'applied' }
        }
        throw new AgentError('Operation could not be claimed for approval.')
      }
      // Bind approval to the immutable fingerprint captured at propose time.
      const fingerprint = claimed.contentFingerprint
      const root = this.currentWorkspace()?.path
      if (!root) {
        this.database.finalizeAgentOperation(operationId, 'failed', { error: 'No workspace is open.' })
        throw new AgentError('No workspace is open.')
      }
      const result = applyClaimedOperation({
        root,
        database: this.database,
        workspace: this.workspace,
        record: claimed,
        expectedFingerprint: fingerprint
      })
      this.publishProposal(result.operation)
      if (result.ok) {
        const paths = [result.operation.path, result.operation.toPath].filter(
          (value): value is string => Boolean(value)
        )
        this.onMutationApplied?.(paths)
      }
      this.noteApprovalResult(missionId, result.operation.callId, {
        state: result.ok ? 'success' : 'failed',
        output: result.output
      })
      return { applied: result.ok, duplicate: false, status: result.operation.status }
    })
  }

  async reject(missionId: string, operationId: string): Promise<{ rejected: boolean }> {
    return this.withMissionLock(missionId, async () => {
      const mission = this.database.getAgentMission(missionId)
      if (!mission) {
        throw new AgentError('Mission not found.')
      }
      if (mission.status !== 'awaiting_approval') {
        throw new AgentError('Mission is not awaiting approval.')
      }
      const existing = this.database.getAgentOperation(operationId)
      if (!existing || existing.missionId !== missionId) {
        throw new AgentError('Operation does not belong to this mission.')
      }
      if (existing.status === 'rejected') {
        return { rejected: true }
      }
      const rejected = this.database.rejectAgentOperation(missionId, operationId)
      if (!rejected) {
        throw new AgentError('Operation could not be rejected.')
      }
      this.publishProposal(rejected)
      this.noteApprovalResult(missionId, rejected.callId, {
        state: 'rejected',
        output: JSON.stringify({
          ok: false,
          outcome: 'rejected',
          operationId,
          status: 'rejected',
          error: 'The user rejected this proposal. Do not retry the identical proposal.'
        })
      })
      return { rejected: true }
    })
  }

  restore(operationId: string): { restored: true } {
    const root = this.currentWorkspace()?.path
    if (!root) {
      throw new AgentError('No workspace is open.')
    }
    return restoreOperation({
      root,
      database: this.database,
      workspace: this.workspace,
      operationId
    })
  }

  private priorMissionContext(missionId: string | undefined, workspacePath: string): string | null {
    if (!missionId) {
      return null
    }
    if (!this.database.agentMissionBelongsToWorkspace(missionId, workspacePath)) {
      return null
    }
    const transcript = this.database.agentTranscript(missionId)
    if (!transcript) {
      return null
    }
    const lines: string[] = [
      'Prior mission context from persisted history (not the live filesystem):',
      `Mission status: ${transcript.mission.status}`,
      `User: ${transcript.mission.prompt}`
    ]
    for (const message of transcript.messages.slice(0, 12)) {
      if (message.role === 'assistant' || message.role === 'user') {
        const cleaned = compactPriorMessage(message.content)
        if (!cleaned) continue
        const text = cleaned.length > 1_200 ? `${cleaned.slice(0, 1_199)}…` : cleaned
        lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
      }
    }
    const ops = transcript.operations.slice(-12)
    if (ops.length > 0) {
      lines.push('Persisted file operations from that mission:')
      for (const op of ops) {
        lines.push(
          `- ${op.status} ${op.kind} ${op.path}${op.toPath ? ` → ${op.toPath}` : ''} id=${op.id}${op.sourceOperationId ? ` source=${op.sourceOperationId}` : ''}`
        )
      }
    }
    lines.push(
      'If the user refers to earlier file changes, call list_file_operations. Do not claim memory of facts that are not in this context or tool results.'
    )
    return lines.join('\n')
  }

  private async execute(
    missionId: string,
    workspace: WorkspaceSnapshot,
    secret: string,
    controller: AbortController,
    priorContext: string | null = null
  ): Promise<void> {
    let iteration = 0
    let streamed = ''
    const flushText = (): void => {
      if (!streamed) {
        return
      }
      this.database.appendAgentMessage(missionId, 'assistant', streamed)
      streamed = ''
    }
    try {
      const result = await runAgentLoop({
        prompt: this.database.getAgentMission(missionId)?.prompt ?? '',
        priorContext,
        workspaceName: workspace.name,
        signal: controller.signal,
        secret,
        client: (input) => {
          iteration += 1
          this.database.setAgentCounters(missionId, iteration, this.database.getAgentMission(missionId)?.toolCalls ?? 0)
          return this.client(input)
        },
        runCommand: (call) =>
          runBrokerCommand({
            root: workspace.path,
            database: this.database,
            missionId,
            callId: call.callId,
            argumentsText: call.arguments,
            signal: controller.signal,
            onSpawn: (pid) => this.onCommandSpawn?.(pid),
            onFinished: (cwdRelative) => this.onCommandFinished?.(cwdRelative)
          }),
        executeTool: (name, argumentsText, cache) => {
          if (name === 'list_file_operations') {
            return listFileOperations({
              database: this.database,
              workspacePath: workspace.path,
              missionId,
              argumentsText
            })
          }
          return executeTool(workspace.path, workspace.name, name, argumentsText, cache)
        },
        proposeMutation: (call) => {
          if (!isMutationTool(call.name)) {
            return {
              execution: {
                state: 'rejected',
                output: JSON.stringify({ ok: false, outcome: 'rejected', error: 'Tool is not available.' })
              },
              operationId: null
            }
          }
          const proposed = proposeMutation({
            root: workspace.path,
            database: this.database,
            missionId,
            callId: call.callId,
            workspacePath: workspace.path,
            name: call.name,
            argumentsText: call.arguments
          })
          if (!proposed.operation) {
            return { execution: proposed.execution, operationId: null }
          }
          if (mutationRequiresApproval(call.name)) {
            this.publishProposal(proposed.operation)
            return { execution: proposed.execution, operationId: proposed.operation.id }
          }
          const claimed = this.database.claimAgentOperation(missionId, proposed.operation.id)
          if (!claimed) {
            return {
              execution: {
                state: 'failed',
                output: JSON.stringify({
                  ok: false,
                  outcome: 'failed',
                  error: 'Unable to claim the file operation for automatic application.'
                })
              },
              operationId: null
            }
          }
          const applied = applyClaimedOperation({
            root: workspace.path,
            database: this.database,
            workspace: this.workspace,
            record: claimed,
            expectedFingerprint: claimed.contentFingerprint
          })
          this.publishProposal(applied.operation)
          if (applied.ok) {
            const paths = [applied.operation.path, applied.operation.toPath].filter(
              (value): value is string => Boolean(value)
            )
            this.onMutationApplied?.(paths)
          }
          return {
            execution: {
              state: applied.ok ? 'success' : 'failed',
              output: applied.output
            },
            operationId: null
          }
        },
        waitForApprovals: (operationIds) => this.waitForApprovals(missionId, operationIds, controller.signal),
        listOperations: () => this.database.listAgentOperations(missionId),
        onStatus: (status) => {
          flushText()
          this.finish(missionId, status, null, null, false)
        },
        onText: (delta) => {
          streamed += delta
          this.onStreamChars?.(delta.length)
          this.publishText(missionId, delta)
        },
        onTool: (call, execution) => this.recordTool(missionId, call, execution, secret)
      })
      flushText()
      if (result.usage) {
        this.onTokenUsage?.({
          input: result.usage.inputTokens,
          output: result.usage.outputTokens,
          model: null
        })
      }
      const mission = this.database.getAgentMission(missionId)
      if (mission && !isTerminalStatus(mission.status)) {
        this.finish(missionId, result.status, result.summary, result.error, true)
      } else if (result.summary || result.error) {
        this.database.setAgentOutcome(missionId, result.summary, result.error)
      }
      if (result.error) {
        this.publish({ type: 'error', missionId, message: redactSensitive(result.error, secret).slice(0, 2_000) })
      }
      const finalStatus = this.database.getAgentMission(missionId)?.status ?? result.status
      this.publish({
        type: 'finished',
        missionId,
        status: finalStatus,
        summary: redactSensitive(result.summary ?? result.error ?? '', secret),
        ...(result.usage ? { usage: result.usage } : {})
      })
    } catch (error) {
      flushText()
      if (controller.signal.aborted) {
        this.finish(missionId, 'cancelled', null, 'The mission was cancelled.', true)
        this.publish({ type: 'finished', missionId, status: 'cancelled', summary: 'The mission was cancelled.' })
      } else {
        const message = error instanceof AgentError ? error.message : 'The mission failed.'
        this.finish(missionId, 'failed', null, message, true)
        this.publish({ type: 'error', missionId, message })
        this.publish({ type: 'finished', missionId, status: 'failed', summary: message })
      }
    } finally {
      this.waiters.delete(missionId)
      this.controllers.delete(missionId)
      this.busy = false
    }
  }

  private waitForApprovals(
    missionId: string,
    operationIds: string[],
    signal: AbortSignal
  ): Promise<Array<{ callId: string; execution: ToolExecution }>> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError())
        return
      }
      const waiter: ApprovalWaiter = {
        missionId,
        operationIds: new Set(operationIds),
        results: new Map(),
        resolve,
        reject
      }
      this.waiters.set(missionId, waiter)
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        void this.withMissionLock(missionId, async () => {
          this.database.cancelPendingAgentOperations(missionId)
          for (const operationId of operationIds) {
            const operation = this.database.getAgentOperation(operationId)
            if (!operation) {
              continue
            }
            this.publishProposal(operation)
            if (!waiter.results.has(operation.callId)) {
              waiter.results.set(operation.callId, {
                callId: operation.callId,
                execution: {
                  state: 'cancelled',
                  output: JSON.stringify({
                    ok: false,
                    outcome: 'cancelled',
                    operationId,
                    status: operation.status,
                    error: operation.error ?? 'The mission was cancelled.'
                  })
                }
              })
            }
          }
          this.settleWaiter(missionId)
        })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      // Already-resolved ops (rejected at propose) are not in the waiter set.
      this.maybeSettleWaiter(missionId)
    })
  }

  private noteApprovalResult(missionId: string, callId: string, execution: ToolExecution): void {
    const waiter = this.waiters.get(missionId)
    if (!waiter) {
      return
    }
    waiter.results.set(callId, { callId, execution })
    this.maybeSettleWaiter(missionId)
  }

  private maybeSettleWaiter(missionId: string): void {
    const waiter = this.waiters.get(missionId)
    if (!waiter) {
      return
    }
    const pending = this.database.listPendingAgentOperations(missionId).filter((op) => waiter.operationIds.has(op.id))
    if (pending.length > 0) {
      return
    }
    for (const operationId of waiter.operationIds) {
      const operation = this.database.getAgentOperation(operationId)
      if (!operation) {
        continue
      }
      if (!waiter.results.has(operation.callId)) {
        const applied = operation.status === 'applied'
        waiter.results.set(operation.callId, {
          callId: operation.callId,
          execution: {
            state: applied ? 'success' : operation.status === 'cancelled' ? 'cancelled' : 'rejected',
            output: JSON.stringify({
              ok: applied,
              outcome: applied ? 'success' : operation.status === 'cancelled' ? 'cancelled' : 'rejected',
              operationId: operation.id,
              status: operation.status,
              path: operation.path,
              applied,
              error: operation.error
            })
          }
        })
      }
    }
    this.settleWaiter(missionId)
  }

  private settleWaiter(missionId: string): void {
    const waiter = this.waiters.get(missionId)
    if (!waiter) {
      return
    }
    this.waiters.delete(missionId)
    waiter.resolve([...waiter.results.values()])
  }

  private async withMissionLock<T>(missionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(missionId) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = previous.catch(() => undefined).then(() => held)
    this.locks.set(missionId, chained)
    await previous.catch(() => undefined)
    try {
      return await work()
    } finally {
      release()
    }
  }

  private finish(missionId: string, status: MissionStatus, summary: string | null, error: string | null, terminal = false): void {
    const current = this.database.getAgentMission(missionId)
    if (!current || isTerminalStatus(current.status)) {
      return
    }
    const stored = this.database.transitionAgentMission(missionId, status, { summary, error })
    if (!stored) {
      return
    }
    this.publish({ type: 'status', missionId, status, title: current.title })
    if (terminal && error) {
      this.publish({ type: 'error', missionId, message: error.slice(0, 2_000) })
    }
  }

  private publishText(missionId: string, delta: string): void {
    const chunks = delta.match(/[\s\S]{1,4000}/g) ?? []
    for (const chunk of chunks) {
      this.publish({ type: 'text', missionId, delta: chunk })
    }
  }

  private recordTool(missionId: string, call: FunctionCall, execution: ToolExecution, secret: string): void {
    const argumentsText = redactSensitive(call.arguments, secret).slice(0, 2_000)
    const output = redactSensitive(execution.output, secret).slice(0, 12_000)
    this.database.recordAgentTool({
      missionId,
      callId: call.callId,
      name: call.name,
      argumentsText,
      state: execution.state,
      output
    })
    this.publish({
      type: 'tool',
      missionId,
      callId: call.callId,
      name: call.name,
      argumentsText,
      state: execution.state,
      output
    })
  }

  private publishProposal(operation: AgentOperationSummary): void {
    this.publish({
      type: 'proposal',
      missionId: operation.missionId,
      operation: proposalEventPayload(operation)
    })
  }

  private publish(event: AgentEvent): void {
    this.emit(event)
  }
}

function abortError(): Error {
  const error = new Error('The mission was cancelled.')
  error.name = 'AbortError'
  return error
}

const LEDGER_LINE =
  /^(Proposed this mission|Applied this mission|Awaiting deletion approval|Awaiting approval|Failed operations|Rejected operations|Cancelled\/stale|Write confirmed by read|Commands:|Discovered during exploration|Mission progress based on|Note: reading a file after writing|Compact execution record:)/i

/** Strip ledger dumps so later turns never re-ingest exploration path lists. */
function compactPriorMessage(content: string): string {
  const lines = content.split(/\n/)
  const kept: string[] = []
  for (const line of lines) {
    if (LEDGER_LINE.test(line.trim())) {
      break
    }
    if (/Discovered during exploration/i.test(line)) {
      break
    }
    kept.push(line)
  }
  return kept.join('\n').trim()
}
