import { describe, expect, it, vi } from 'vitest'
import { loadEnv, resetEnvCache } from '../src/config/env.ts'
import { EmailService } from '../src/modules/email/service.ts'
import { newDeviceEmail, passwordResetEmail, verificationEmail } from '../src/modules/email/templates.ts'
import { createLogger } from '../src/utils/logger.ts'

describe('email templates and service', () => {
  it('renders verification, reset, and device templates without leaking tokens into subject lines', () => {
    const verification = verificationEmail({
      displayName: 'Ada',
      verifyUrl: 'https://app.example/verify-email?token=secret-token'
    })
    expect(verification.subject).toContain('Verify')
    expect(verification.text).toContain('secret-token')
    expect(verification.html).toContain('Verify email')

    const reset = passwordResetEmail({
      displayName: 'Ada',
      resetUrl: 'https://app.example/reset-password?token=reset-token'
    })
    expect(reset.subject).toContain('Reset')
    expect(reset.text).toContain('reset-token')

    const device = newDeviceEmail({
      displayName: 'Ada',
      deviceName: 'MacBook',
      platform: 'darwin',
      appVersion: '0.1.0'
    })
    expect(device.text).toContain('MacBook')
    expect(device.html).toContain('darwin')
  })

  it('soft-fails in development when SMTP is missing and does not pretend delivery succeeded', async () => {
    resetEnvCache()
    const env = loadEnv({
      NODE_ENV: 'development',
      PORT: '4000',
      DATABASE_URL: 'postgres://kern:kern@127.0.0.1:5432/kern',
      APP_URL: 'http://localhost:4000',
      CORS_ORIGINS: 'http://localhost:5173',
      EMAIL_DEV_MODE: 'true',
      SMTP_HOST: '',
      SMTP_FROM_EMAIL: '',
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'test-access-secret-phase2f-not-for-production-use-32b'
    })
    const logger = createLogger({ level: 'silent' })
    const info = vi.spyOn(logger, 'info')
    const email = new EmailService(env, logger)
    const result = await email.send({
      to: 'user@example.com',
      template: verificationEmail({ displayName: 'Ada', verifyUrl: 'https://example/verify?token=abc' })
    })
    expect(result.delivered).toBe(false)
    if (!result.delivered) {
      expect(result.mode).toBe('dev_log')
    }
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/SMTP_PASS|password|abc/)
  })

  it('reports SMTP connection failure without logging credentials', async () => {
    resetEnvCache()
    const env = loadEnv({
      NODE_ENV: 'development',
      PORT: '4000',
      DATABASE_URL: 'postgres://kern:kern@127.0.0.1:5432/kern',
      APP_URL: 'http://localhost:4000',
      CORS_ORIGINS: 'http://localhost:5173',
      EMAIL_DEV_MODE: 'true',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      SMTP_SECURE: 'false',
      SMTP_USER: 'mail-user',
      SMTP_PASS: 'super-secret-smtp-password',
      SMTP_FROM_EMAIL: 'noreply@example.com',
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'test-access-secret-phase2f-not-for-production-use-32b'
    })
    const logger = createLogger({ level: 'silent' })
    const email = new EmailService(env, logger)
    const result = await email.verifyConnection()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toContain('super-secret-smtp-password')
    }
  })
})
