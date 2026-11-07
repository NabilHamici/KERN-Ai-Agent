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
  return provider === 'cursor' ? 'Cursor' : 'BharatCode'
}

export function connectionLabel(state: ConnectionState, running: boolean): string {
  if (running) {
    return 'Running'
  }
  switch (state) {
    case 'not_configured':
      return 'Not configured'
    case 'credentials_stored':
      return 'Not verified'
    case 'verified':
      return 'Verified'
    case 'authentication_failed':
      return 'Auth failed'
    case 'usage_restricted':
      return 'Usage restricted'
    case 'unavailable':
      return 'Unavailable'
  }
}

export function connectionDetail(provider: ProviderId, state: ConnectionState): string {
  const name = providerLabel(provider)
  switch (state) {
    case 'not_configured':
      return provider === 'cursor'
        ? 'Cursor is not signed in on this Mac. KERN uses the saved Cursor login, not a pasted API key.'
        : `No ${name} API key is stored.`
    case 'credentials_stored':
      return provider === 'cursor'
        ? 'Signed in with the Cursor login on this Mac. The connection has not been verified.'
        : 'A key is stored. The connection has not been verified.'
    case 'verified':
      return `The last ${name} check succeeded.`
    case 'authentication_failed':
      return provider === 'cursor'
        ? 'Cursor could not use the saved login on this Mac.'
        : `${name} rejected the API key.`
    case 'usage_restricted':
      return provider === 'cursor'
        ? 'Cursor usage is outside the included Composer 2.5 pool for this account.'
        : 'BharatCode rejected the request because the account cannot use the API.'
    case 'unavailable':
      return `${name} could not be reached.`
  }
}
