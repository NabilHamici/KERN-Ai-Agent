import fs from 'node:fs'
import { Agent, Cursor, emptyFs, type AgentOptions, type SDKMessage } from '@cursor/sdk'
import { CURSOR_INCLUDED_MODEL, type ConnectionState } from '../../shared/provider.ts'
import { assertCursorModel, KERN_TOOL_NAMES, type CursorBridge, type CursorBridgeResult } from './cursorProvider.ts'
import { MODEL_TOOLS } from './tools.ts'

const BLOCKED_TOOLS = [
  'shell',
  'read',
  'edit',
  'grep',
  'glob',
  'ls',
  'task',
  'webSearch',
  'delete',
  'readLints',
  'webFetch',
  'semSearch',
  'updateTodos',
  'readTodos',
  'askQuestion',
  'await',
  'generateImage',
  'applyAgentDiff'
] as const

function abortError(): Error {
  const error = new Error('The model request was cancelled.')
  error.name = 'AbortError'
  return error
}

function toolParameters(name: string): Record<string, never> {
  const tool = MODEL_TOOLS.find((item) => item.name === name)
  return (tool?.parameters ?? { type: 'object', additionalProperties: false }) as unknown as Record<string, never>
}

export function cursorAgentOptions(input: {
  apiKey?: string
  stateDir: string
  onTool: (name: string, args: Record<string, unknown>, callId: string) => void
}): AgentOptions {
  assertCursorModel(CURSOR_INCLUDED_MODEL)
  const customTools: NonNullable<AgentOptions['local']>['customTools'] = {}
  for (const name of KERN_TOOL_NAMES) {
    const description = MODEL_TOOLS.find((item) => item.name === name)?.description ?? name
    customTools[name] = {
      description,
      inputSchema: toolParameters(name),
      execute: (args, context) => {
        input.onTool(name, args, context.toolCallId ?? '')
        return 'Recorded for the KERN tool broker.'
      }
    }
  }
  const apiKey = input.apiKey?.trim()
  return {
    apiKey: apiKey ? apiKey : undefined,
    model: { id: CURSOR_INCLUDED_MODEL },
    tools: ['mcp'],
    disallowedTools: [...BLOCKED_TOOLS],
    local: {
      cwd: input.stateDir,
      settingSources: [],
      enableAgentRetries: false,
      fs: emptyFs(),
      customTools
    }
  }
}

function foreignToolName(message: SDKMessage): string | null {
  if (message.type !== 'tool_call') {
    return null
  }
  return (BLOCKED_TOOLS as readonly string[]).includes(message.name) ? message.name : null
}

export function createCursorSdkBridge(stateDir: string): CursorBridge {
  return {
    async run(input): Promise<CursorBridgeResult> {
      fs.mkdirSync(stateDir, { recursive: true })
      let active: Awaited<ReturnType<typeof Agent.create>> | null = null
      let run: Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>['send']>> | null = null
      const options = cursorAgentOptions({
        apiKey: input.apiKey,
        stateDir,
        onTool: (name, args, callId) => {
          input.handleTool({ callId, name, arguments: args })
          if (run?.supports('cancel')) {
            void run.cancel()
          }
        }
      })
      try {
        if (input.signal.aborted) {
          throw abortError()
        }
        active = await Agent.create(options)
        const sent = await active.send(input.prompt, {
          onDelta: ({ update }) => {
            if (update.type === 'text-delta') {
              input.onDelta(update.text)
            }
          }
        })
        run = sent
        const onAbort = (): void => {
          if (sent.supports('cancel')) {
            void sent.cancel()
          }
        }
        input.signal.addEventListener('abort', onAbort, { once: true })
        let text = ''
        for await (const message of sent.stream()) {
          if (message.type === 'assistant') {
            for (const block of message.message.content) {
              if (block.type === 'text' && block.text) {
                text += block.text
              }
            }
          }
          const foreign = foreignToolName(message)
          if (foreign) {
            input.handleForeignTool(foreign)
            if (sent.supports('cancel')) {
              await sent.cancel()
            }
          }
        }
        const result = await sent.wait()
        input.signal.removeEventListener('abort', onAbort)
        if (input.signal.aborted) {
          throw abortError()
        }
        return {
          status: result.status,
          text: result.result || text,
          requestId: result.requestId ?? sent.requestId ?? null,
          usage: result.usage
            ? {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                totalTokens: result.usage.totalTokens
              }
            : undefined,
          errorMessage: result.error?.message,
          errorName: result.error?.code
        }
      } finally {
        await active?.[Symbol.asyncDispose]()
      }
    }
  }
}

export async function cursorUsesStoredLogin(): Promise<boolean> {
  try {
    const status = await Cursor.auth.status()
    return status.status === 'logged-in'
  } catch {
    return false
  }
}

export async function listCursorModels(apiKey?: string): Promise<{ ids: string[] }> {
  const models = await Cursor.models.list(apiKey?.trim() ? { apiKey: apiKey.trim() } : {})
  return { ids: models.map((model) => model.id) }
}

export async function probeCursorAccount(apiKey?: string | null): Promise<ConnectionState> {
  const explicit = apiKey?.trim()
  if (!explicit && !(await cursorUsesStoredLogin())) {
    return 'not_configured'
  }
  try {
    const listed = await listCursorModels(explicit)
    return listed.ids.includes(CURSOR_INCLUDED_MODEL) ? 'verified' : 'usage_restricted'
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined
    if (name === 'AuthenticationError' || status === 401) {
      return 'authentication_failed'
    }
    if (name === 'RateLimitError' || status === 402 || status === 429) {
      return 'usage_restricted'
    }
    return 'unavailable'
  }
}
