import pino from 'pino'
import { getEnv } from '../config/env.js'

const REDACT_PATHS = [
  'password',
  'passwordHash',
  'SMTP_PASS',
  'smtpPass',
  'pass',
  'token',
  'accessToken',
  'refreshToken',
  'refreshTokenHash',
  'authorization',
  'cookie',
  'DATABASE_URL',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie'
]

export function createLogger(overrides?: { level?: string }) {
  const env = (() => {
    try {
      return getEnv()
    } catch {
      return null
    }
  })()

  return pino({
    level: overrides?.level ?? env?.LOG_LEVEL ?? 'info',
    redact: {
      paths: REDACT_PATHS,
      censor: '[Redacted]'
    },
    base: {
      service: 'kern-server'
    }
  })
}

export type Logger = ReturnType<typeof createLogger>
