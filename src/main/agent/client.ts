import type { ProviderId } from '../../shared/provider.ts'
import type { MissionDatabase } from '../services/database.ts'
import { requestCursor, type CursorBridge } from './cursorProvider.ts'
import type { ModelClient } from './loop.ts'
import { requestBharatCode, type ProviderTurn } from './provider.ts'
import { rememberConnection } from './providerSettings.ts'

function remember(database: MissionDatabase, provider: ProviderId, turn: ProviderTurn): void {
  if (turn.kind === 'completed') {
    rememberConnection(database, provider, 'verified')
    return
  }
  if (turn.kind !== 'failed' || !turn.code) {
    return
  }
  if (turn.code === 'authentication') {
    rememberConnection(database, provider, 'authentication_failed')
  } else if (turn.code === 'usage') {
    rememberConnection(database, provider, 'usage_restricted')
  } else if (turn.code === 'unavailable') {
    rememberConnection(database, provider, 'unavailable')
  }
}

export function createProductionClient(options: {
  database: MissionDatabase
  readProvider: () => ProviderId
  readKey: (provider: ProviderId) => Promise<string | null>
  cursor: CursorBridge
}): ModelClient {
  return async (input) => {
    const provider = options.readProvider()
    const key = (await options.readKey(provider)) ?? ''
    if (!key && provider !== 'cursor') {
      const turn: ProviderTurn = {
        kind: 'failed',
        code: 'authentication',
        message: 'No BharatCode API key is stored.',
        requestId: null
      }
      remember(options.database, provider, turn)
      return turn
    }
    const turn =
      provider === 'cursor'
        ? await requestCursor({
            apiKey: key,
            instructions: input.instructions,
            input: input.input,
            signal: input.signal,
            onDelta: input.onDelta,
            bridge: options.cursor
          })
        : await requestBharatCode({
            apiKey: key,
            instructions: input.instructions,
            input: input.input,
            tools: input.tools,
            signal: input.signal,
            onDelta: input.onDelta
          })
    remember(options.database, provider, turn)
    return turn
  }
}
