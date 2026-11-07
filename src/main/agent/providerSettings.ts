import type { MissionDatabase } from '../services/database.ts'
import {
  connectionDetail,
  isConnectionState,
  isProviderId,
  type ConnectionState,
  type ProviderId
} from '../../shared/provider.ts'

export const PROVIDER_SETTING = 'model.provider'

export type ProviderSnapshot = {
  provider: ProviderId
  state: ConnectionState
  bharatCodeConfigured: boolean
  cursorConfigured: boolean
  detail: string
}

function checkKey(provider: ProviderId): string {
  return `model.check.${provider}`
}

export function readProviderId(database: MissionDatabase): ProviderId {
  const stored = database.getSetting(PROVIDER_SETTING)
  return isProviderId(stored) ? stored : 'bharatcode'
}

export function writeProviderId(database: MissionDatabase, provider: ProviderId): void {
  database.setSetting(PROVIDER_SETTING, provider)
}

export function connectionState(configured: boolean, stored: string | null): ConnectionState {
  if (!configured) {
    return 'not_configured'
  }
  if (isConnectionState(stored) && stored !== 'not_configured' && stored !== 'credentials_stored') {
    return stored
  }
  return 'credentials_stored'
}

export function providerSnapshot(
  database: MissionDatabase,
  configured: { bharatcode: boolean; cursor: boolean }
): ProviderSnapshot {
  const provider = readProviderId(database)
  const state = connectionState(configured[provider], database.getSetting(checkKey(provider)))
  return {
    provider,
    state,
    bharatCodeConfigured: configured.bharatcode,
    cursorConfigured: configured.cursor,
    detail: connectionDetail(provider, state)
  }
}

export async function checkSelectedProvider(options: {
  database: MissionDatabase
  configured: { bharatcode: boolean; cursor: boolean }
  readKey: (provider: ProviderId) => Promise<string | null>
  probe: (provider: ProviderId, apiKey: string) => Promise<ConnectionState>
}): Promise<ProviderSnapshot> {
  const provider = readProviderId(options.database)
  if (!options.configured[provider]) {
    rememberConnection(options.database, provider, 'not_configured')
    return providerSnapshot(options.database, options.configured)
  }
  const key = (await options.readKey(provider)) ?? ''
  if (provider !== 'cursor' && !key) {
    rememberConnection(options.database, provider, 'not_configured')
    return providerSnapshot(options.database, options.configured)
  }
  const state = await options.probe(provider, key)
  rememberConnection(options.database, provider, state)
  return providerSnapshot(options.database, options.configured)
}

export function rememberConnection(database: MissionDatabase, provider: ProviderId, state: ConnectionState): void {
  if (state === 'not_configured' || state === 'credentials_stored') {
    database.deleteSetting(checkKey(provider))
    return
  }
  database.setSetting(checkKey(provider), state)
}
