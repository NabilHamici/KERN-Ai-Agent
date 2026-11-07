import {
  AgentError,
  isTerminalStatus,
  redactSensitive,
  type AgentEvent,
  type AgentMissionSummary,
  type AgentTranscript,
  type MissionStatus
} from '../../shared/agent.ts'
import type { ProviderId } from '../../shared/provider.ts'
import type { MissionDatabase } from '../services/database.ts'
import { runAgentLoop, type ModelClient } from './loop.ts'
import { requestBharatCode, type ProviderTurn } from './provider.ts'
import { executeTool } from './tools.ts'
import type { FunctionCall } from './provider.ts'
import type { ToolExecution } from './tools.ts'

type WorkspaceSnapshot = { path: string; name: string }

export class AgentRuntime {
  private busy = false
  private tail: Promise<void> = Promise.resolve()
  private readonly controllers = new Map<string, AbortController>()
  private readonly database: MissionDatabase
  private readonly currentWorkspace: () => WorkspaceSnapshot | null
  private readonly readApiKey: () => Promise<string | null>
  private readonly cursorReady: () => Promise<boolean>
  private readonly readProvider: () => ProviderId
  private readonly emit: (event: AgentEvent) => void
  private readonly client: ModelClient

  constructor(options: {
    database: MissionDatabase
    currentWorkspace: () => WorkspaceSnapshot | null
    readApiKey: () => Promise<string | null>
    cursorReady?: () => Promise<boolean>
    readProvider?: () => ProviderId
    emit: (event: AgentEvent) => void
    client?: ModelClient
  }) {
    this.database = options.database
    this.currentWorkspace = options.currentWorkspace
    this.readApiKey = options.readApiKey
    this.cursorReady = options.cursorReady ?? (async () => false)
    this.readProvider = options.readProvider ?? (() => 'bharatcode')
    this.emit = options.emit
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

  async submit(prompt: string): Promise<{ missionId: string }> {
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
      const mission = this.database.createAgentMission(workspace.path, prompt)
      const controller = new AbortController()
      this.controllers.set(mission.id, controller)
      this.publish({ type: 'status', missionId: mission.id, status: 'queued', title: mission.title })
      this.tail = this.execute(mission.id, workspace, key ?? '', controller)
      return { missionId: mission.id }
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
    this.finish(missionId, 'cancelled', null, 'The mission was cancelled.')
    controller.abort()
    return { cancelled: true }
  }

  stopAll(): void {
    for (const missionId of this.controllers.keys()) {
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

  private async execute(missionId: string, workspace: WorkspaceSnapshot, secret: string, controller: AbortController): Promise<void> {
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
        workspaceName: workspace.name,
        signal: controller.signal,
        secret,
        client: (input) => {
          iteration += 1
          this.database.setAgentCounters(missionId, iteration, this.database.getAgentMission(missionId)?.toolCalls ?? 0)
          return this.client(input)
        },
        executeTool: (name, argumentsText) => executeTool(workspace.path, workspace.name, name, argumentsText),
        onStatus: (status) => {
          flushText()
          this.finish(missionId, status, null, null, false)
        },
        onText: (delta) => {
          streamed += delta
          this.publishText(missionId, delta)
        },
        onTool: (call, execution) => this.recordTool(missionId, call, execution, secret)
      })
      flushText()
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
      this.controllers.delete(missionId)
      this.busy = false
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

  private publish(event: AgentEvent): void {
    this.emit(event)
  }
}
