import { z } from 'zod'

export const PROVIDER_IDS = ['bharatcode', 'cursor'] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export const CONNECTION_STATES = [
  'not_configured',
  'credentials_stored',
  'verified',
  'authentication_failed',
  'usage_restricted',
  'unavailable'
] as const

export type ConnectionState = (typeof CONNECTION_STATES)[number]

export const CURSOR_INCLUDED_MODEL = 'composer-2.5'
export const BHARATCODE_MODEL_ID = 'qwen-3.8-27b'

export const providerSetSchema = z.strictObject({
  provider: z.enum(PROVIDER_IDS)
})

export function isProviderId(value: string | null | undefined): value is ProviderId {
  return value === 'bharatcode' || value === 'cursor'
}

export function isConnectionState(value: string | null | undefined): value is ConnectionState {
  return (CONNECTION_STATES as readonly string[]).includes(value ?? '')
}

export function providerLabel(provider: ProviderId): string {
  return provider === 'cursor' ? 'dev provider' : 'BharatCode'
}

/** Human-facing model id (real configured model; no product branding). */
export function modelDisplayName(provider: ProviderId): string {
  return provider === 'cursor' ? CURSOR_INCLUDED_MODEL : BHARATCODE_MODEL_ID
}

/** Header/status chip: provider · model, or No provider when unset. */
export function providerModelChip(
  provider: ProviderId | null | undefined,
  connection: ConnectionState | null | undefined
): { title: string; detail: string } {
  if (!provider || connection === 'not_configured') {
    return { title: 'No provider', detail: 'Configure BharatCode in Settings.' }
  }
  return {
    title: `${providerLabel(provider)} · ${modelDisplayName(provider)}`,
    detail: connectionDetail(provider, connection ?? 'not_configured')
  }
}

export function connectionLabel(state: ConnectionState, running: boolean): string {
  if (running) {
    return 'Running'
  }
  switch (state) {
    case 'not_configured':
      return 'Not configured'
    case 'credentials_stored':
      return 'Key stored'
    case 'verified':
      return 'Healthy'
    case 'authentication_failed':
      return 'Auth failed'
    case 'usage_restricted':
      return 'Usage restricted'
    case 'unavailable':
      return 'Unavailable'
  }
}

export function connectionDetail(provider: ProviderId, state: ConnectionState): string {
  const model = modelDisplayName(provider)
  switch (state) {
    case 'not_configured':
      return provider === 'cursor'
        ? `No local SDK login is available for model ${model}.`
        : `No BharatCode API key is stored for ${model}.`
    case 'credentials_stored':
      return provider === 'cursor'
        ? `SDK login is available for ${model}. Connection has not been checked.`
        : `Key stored for ${model}. Connection has not been checked.`
    case 'verified':
      return `Last health check for ${model} succeeded.`
    case 'authentication_failed':
      return provider === 'cursor'
        ? `SDK login could not be used for ${model}.`
        : `BharatCode rejected the API key for ${model}.`
    case 'usage_restricted':
      return provider === 'cursor'
        ? `Usage for ${model} is restricted on this account.`
        : 'BharatCode rejected the request because the account cannot use the API.'
    case 'unavailable':
      return `${model} could not be reached.`
  }
}
