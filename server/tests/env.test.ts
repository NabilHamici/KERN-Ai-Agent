import { describe, expect, it } from 'vitest'
import { loadEnv, resetEnvCache } from '../src/config/env.ts'

const base = {
  NODE_ENV: 'development',
  PORT: '4000',
  DATABASE_URL: 'postgres://kern:kern@127.0.0.1:5432/kern',
  APP_URL: 'http://localhost:4000',
  CORS_ORIGINS: 'http://localhost:5173',
  EMAIL_DEV_MODE: 'true',
  LOG_LEVEL: 'silent',
  JWT_ACCESS_SECRET: 'test-access-secret-phase2f-not-for-production-use-32b'
}

describe('environment configuration', () => {
  it('loads valid development configuration', () => {
    resetEnvCache()
    const env = loadEnv(base)
    expect(env.PORT).toBe(4000)
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173'])
    expect(env.EMAIL_DEV_MODE).toBe(true)
  })

  it('fails fast when DATABASE_URL is missing', () => {
    resetEnvCache()
    expect(() => loadEnv({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/)
  })

  it('requires SMTP in production and rejects email dev mode', () => {
    resetEnvCache()
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        EMAIL_DEV_MODE: 'true',
        SMTP_HOST: 'smtp.example.com',
        SMTP_FROM_EMAIL: 'noreply@example.com'
      })
    ).toThrow(/EMAIL_DEV_MODE/)

    resetEnvCache()
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        EMAIL_DEV_MODE: 'false',
        SMTP_HOST: '',
        SMTP_FROM_EMAIL: ''
      })
    ).toThrow(/SMTP/)
  })
})
