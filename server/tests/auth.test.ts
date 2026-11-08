import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { createApp } from '../src/app.ts'
import { createPool } from '../src/config/database.ts'
import { loadEnv, resetEnvCache } from '../src/config/env.ts'
import * as schema from '../src/db/schema/index.ts'
import { hashOtp } from '../src/modules/auth/crypto.ts'
import { EmailService, type SendEmailInput, type SendEmailResult } from '../src/modules/email/service.ts'
import { createLogger } from '../src/utils/logger.ts'

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip

class CapturingEmail extends EmailService {
  lastCode: string | null = null
  failNext = false

  override async send(input: SendEmailInput): Promise<SendEmailResult> {
    const match = `${input.template.text}\n${input.template.html}`.match(/\b(\d{6})\b/)
    this.lastCode = match?.[1] ?? null
    if (this.failNext) {
      this.failNext = false
      return { delivered: false, mode: 'dev_log', reason: 'forced failure' }
    }
    return { delivered: true, messageId: `test-${randomUUID()}`, mode: 'smtp' }
  }
}

function device(suffix: string) {
  return {
    deviceName: `test-device-${suffix}`,
    platform: 'test',
    appVersion: '0.1.0',
    installationId: `install-${suffix}-${randomUUID()}`.slice(0, 64)
  }
}

maybeDescribe('auth registration, OTP, and sessions', () => {
  resetEnvCache()
  const env = loadEnv({
    NODE_ENV: 'test',
    PORT: '4000',
    DATABASE_URL: databaseUrl!,
    APP_URL: 'http://localhost:4000',
    CORS_ORIGINS: 'http://localhost:5173',
    EMAIL_DEV_MODE: 'true',
    SMTP_HOST: '',
    SMTP_FROM_EMAIL: '',
    LOG_LEVEL: 'silent',
    JWT_ACCESS_SECRET: 'test-access-secret-phase2f-not-for-production-use-32b',
    ACCESS_TOKEN_TTL_SECONDS: '900',
    REFRESH_TOKEN_TTL_DAYS: '30'
  })
  const logger = createLogger({ level: 'silent' })
  const pool = createPool(databaseUrl!)
  const db = drizzle(pool, { schema })
  const email = new CapturingEmail(env, logger)
  const app = createApp({ env, logger, email, db })

  beforeAll(async () => {
    await pool.query('SELECT 1')
  })

  afterAll(async () => {
    await pool.end()
  })

  it('registers, stores hashed OTP, verifies, and creates a session', async () => {
    const suffix = randomUUID().slice(0, 8)
    const address = `user-${suffix}@example.com`
    const register = await request(app)
      .post('/api/v1/auth/register')
      .send({
        fullName: 'Ada Lovelace',
        email: address,
        password: 'Secret123',
        confirmPassword: 'Secret123',
        device: device(suffix)
      })
    expect(register.status).toBe(201)
    expect(register.body.data.verificationRequired).toBe(true)
    expect(register.body.data.user.accountStatus).toBe('pending_verification')
    expect(email.lastCode).toMatch(/^\d{6}$/)
    expect(JSON.stringify(register.body)).not.toContain(email.lastCode)

    const user = await db.query.users.findFirst({ where: eq(schema.users.email, address) })
    expect(user).toBeTruthy()
    const otp = await db.query.emailVerificationOtps.findFirst({
      where: and(eq(schema.emailVerificationOtps.userId, user!.id), isNull(schema.emailVerificationOtps.consumedAt))
    })
    expect(otp?.codeHash).toBe(hashOtp(email.lastCode!))
    expect(otp?.codeHash).not.toBe(email.lastCode)

    const verify = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: address, code: email.lastCode, device: device(`${suffix}-v`) })
    expect(verify.status).toBe(200)
    expect(verify.body.data.user.emailVerified).toBe(true)
    expect(verify.body.data.accessToken).toBeTruthy()
    expect(verify.body.data.refreshToken).toBeTruthy()
    expect(JSON.stringify(verify.body)).not.toMatch(/passwordHash|refreshTokenHash/)
  })

  it('rejects weak passwords, mismatches, invalid email, and duplicates', async () => {
    const suffix = randomUUID().slice(0, 8)
    const address = `dup-${suffix}@example.com`
    const devicePayload = device(suffix)

    expect(
      (
        await request(app).post('/api/v1/auth/register').send({
          fullName: 'Weak',
          email: address,
          password: 'short',
          confirmPassword: 'short',
          device: devicePayload
        })
      ).status
    ).toBe(400)

    expect(
      (
        await request(app).post('/api/v1/auth/register').send({
          fullName: 'Mismatch',
          email: address,
          password: 'Secret123',
          confirmPassword: 'Secret124',
          device: devicePayload
        })
      ).status
    ).toBe(400)

    expect(
      (
        await request(app).post('/api/v1/auth/register').send({
          fullName: 'Bad',
          email: 'not-an-email',
          password: 'Secret123',
          confirmPassword: 'Secret123',
          device: devicePayload
        })
      ).status
    ).toBe(400)

    const first = await request(app).post('/api/v1/auth/register').send({
      fullName: 'First',
      email: address,
      password: 'Secret123',
      confirmPassword: 'Secret123',
      device: device(suffix)
    })
    expect(first.status).toBe(201)
    const second = await request(app).post('/api/v1/auth/register').send({
      fullName: 'Second',
      email: address,
      password: 'Secret123',
      confirmPassword: 'Secret123',
      device: device(`${suffix}-2`)
    })
    expect(second.status).toBe(409)
  })

  it('rejects incorrect OTP and allows verified login afterwards', async () => {
    const suffix = randomUUID().slice(0, 8)
    const address = `otp-${suffix}@example.com`
    await request(app)
      .post('/api/v1/auth/register')
      .send({
        fullName: 'Otp User',
        email: address,
        password: 'Secret123',
        confirmPassword: 'Secret123',
        device: device(suffix)
      })
    const code = email.lastCode!

    const wrong = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: address, code: '000000', device: device(`${suffix}-w`) })
    expect(wrong.status).toBe(400)

    const ok = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: address, code, device: device(`${suffix}-ok`) })
    expect(ok.status).toBe(200)

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: address, password: 'Secret123', device: device(`${suffix}-l`) })
    expect(login.status).toBe(200)
  })

  it('enforces resend cooldown and keeps pending state when SMTP fails', async () => {
    const suffix = randomUUID().slice(0, 8)
    const address = `smtp-${suffix}@example.com`
    email.failNext = true
    const register = await request(app)
      .post('/api/v1/auth/register')
      .send({
        fullName: 'Smtp Fail',
        email: address,
        password: 'Secret123',
        confirmPassword: 'Secret123',
        device: device(suffix)
      })
    expect(register.status).toBe(201)
    expect(register.body.data.emailDeliveryFailed).toBe(true)
    expect(register.body.data.user.accountStatus).toBe('pending_verification')

    const immediate = await request(app).post('/api/v1/auth/resend-verification').send({ email: address })
    expect(immediate.status).toBe(429)
  })

  it('logs in, rotates refresh tokens, detects reuse, and logs out', async () => {
    const suffix = randomUUID().slice(0, 8)
    const address = `login-${suffix}@example.com`
    const password = 'Secret123'
    await request(app)
      .post('/api/v1/auth/register')
      .send({
        fullName: 'Login User',
        email: address,
        password,
        confirmPassword: password,
        device: device(suffix)
      })
    const verify = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: address, code: email.lastCode, device: device(`${suffix}-v`) })
    const refreshToken = verify.body.data.refreshToken as string

    const badLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: address, password: 'Wrong1234', device: device(`${suffix}-bad`) })
    expect(badLogin.status).toBe(401)

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: address, password, device: device(`${suffix}-ok`) })
    expect(login.status).toBe(200)

    const rotated = await request(app).post('/api/v1/auth/refresh').send({ refreshToken })
    expect(rotated.status).toBe(200)
    const nextRefresh = rotated.body.data.refreshToken as string
    expect(nextRefresh).not.toBe(refreshToken)

    const reuse = await request(app).post('/api/v1/auth/refresh').send({ refreshToken })
    expect(reuse.status).toBe(401)

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${login.body.data.accessToken}`)
    expect(me.status).toBe(200)
    expect(me.body.data.email).toBe(address)

    const logout = await request(app).post('/api/v1/auth/logout').send({ refreshToken: nextRefresh })
    expect(logout.status).toBe(200)
  })

  it('returns generic forgot-password responses and resets with a code', async () => {
    const suffix = randomUUID().slice(0, 8)
    const address = `reset-${suffix}@example.com`
    await request(app)
      .post('/api/v1/auth/register')
      .send({
        fullName: 'Reset User',
        email: address,
        password: 'Secret123',
        confirmPassword: 'Secret123',
        device: device(suffix)
      })
    await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ email: address, code: email.lastCode, device: device(`${suffix}-v`) })

    const missing = await request(app).post('/api/v1/auth/forgot-password').send({ email: `missing-${suffix}@example.com` })
    const existing = await request(app).post('/api/v1/auth/forgot-password').send({ email: address })
    expect(missing.status).toBe(200)
    expect(existing.status).toBe(200)
    expect(missing.body.data.accepted).toBe(true)
    expect(existing.body.data.accepted).toBe(true)

    const reset = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({
        email: address,
        code: email.lastCode,
        password: 'NewSecret123',
        confirmPassword: 'NewSecret123'
      })
    expect(reset.status).toBe(200)

    const oldLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: address, password: 'Secret123', device: device(`${suffix}-old`) })
    expect(oldLogin.status).toBe(401)

    const newLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: address, password: 'NewSecret123', device: device(`${suffix}-new`) })
    expect(newLogin.status).toBe(200)
  })

  it('routes unverified login to verification and rejects suspended accounts', async () => {
    const suffix = randomUUID().slice(0, 8)
    const address = `pending-${suffix}@example.com`
    await request(app)
      .post('/api/v1/auth/register')
      .send({
        fullName: 'Pending',
        email: address,
        password: 'Secret123',
        confirmPassword: 'Secret123',
        device: device(suffix)
      })
    const pendingLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: address, password: 'Secret123', device: device(`${suffix}-l`) })
    expect(pendingLogin.status).toBe(200)
    expect(pendingLogin.body.data.verificationRequired).toBe(true)

    await pool.query(`UPDATE users SET account_status = 'suspended' WHERE email = $1`, [address])
    const suspended = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: address, password: 'Secret123', device: device(`${suffix}-s`) })
    expect(suspended.status).toBe(403)
  })
})
