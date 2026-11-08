import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import { createApp } from '../src/app.ts'
import { createPool } from '../src/config/database.ts'
import { loadEnv, resetEnvCache } from '../src/config/env.ts'
import * as schema from '../src/db/schema/index.ts'
import { EmailService } from '../src/modules/email/service.ts'
import { createLogger } from '../src/utils/logger.ts'

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

const maybeDescribe = databaseUrl ? describe : describe.skip

maybeDescribe('API foundation', () => {
  const env = (() => {
    resetEnvCache()
    return loadEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL: databaseUrl!,
      APP_URL: 'http://localhost:4000',
      CORS_ORIGINS: 'http://localhost:5173,http://allowed.example',
      EMAIL_DEV_MODE: 'true',
      SMTP_HOST: '',
      SMTP_FROM_EMAIL: '',
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'test-access-secret-phase2f-not-for-production-use-32b'
    })
  })()

  const logger = createLogger({ level: 'silent' })
  const email = new EmailService(env, logger)
  const pool = createPool(databaseUrl!)
  const db = drizzle(pool, { schema })
  const app = createApp({ env, logger, email, db })

  beforeAll(async () => {
    await pool.query('SELECT 1')
  })

  afterAll(async () => {
    await pool.end()
  })

  it('returns a safe health payload', async () => {
    const response = await request(app).get('/api/v1/health')
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.data.service).toBe('kern-server')
    expect(response.body.data.checks.database).toMatch(/up|down/)
    expect(JSON.stringify(response.body)).not.toMatch(/postgres:\/\/|SMTP_PASS|password/)
  })

  it('returns readiness based on database connectivity', async () => {
    const response = await request(app).get('/api/v1/ready')
    expect([200, 503]).toContain(response.status)
    expect(response.body.ok === true || response.body.error.code === 'not_ready').toBe(true)
  })

  it('returns live status without DB dependency', async () => {
    const response = await request(app).get('/api/v1/live')
    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('alive')
    expect(response.headers['x-correlation-id']).toBeTruthy()
  })

  it('rejects unknown routes with a consistent error shape', async () => {
    const response = await request(app).get('/api/v1/does-not-exist')
    expect(response.status).toBe(404)
    expect(response.body.ok).toBe(false)
    expect(response.body.error.code).toBe('not_found')
  })

  it('enforces request size limits', async () => {
    const huge = 'x'.repeat(120_000)
    const response = await request(app).post('/api/v1/health').set('content-type', 'application/json').send({ payload: huge })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('allows allowlisted CORS origins and blocks others', async () => {
    const allowed = await request(app).get('/api/v1/live').set('Origin', 'http://allowed.example')
    expect(allowed.headers['access-control-allow-origin']).toBe('http://allowed.example')

    const blocked = await request(app).get('/api/v1/live').set('Origin', 'http://evil.example')
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('API without database dependency for offline contracts', () => {
  it('does not expose filesystem or shell routes', async () => {
    resetEnvCache()
    const env = loadEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL: 'postgres://kern:kern@127.0.0.1:5432/kern',
      APP_URL: 'http://localhost:4000',
      CORS_ORIGINS: 'http://localhost:5173',
      EMAIL_DEV_MODE: 'true',
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'test-access-secret-phase2f-not-for-production-use-32b'
    })
    const logger = createLogger({ level: 'silent' })
    const pool = createPool(env.DATABASE_URL)
    const db = drizzle(pool, { schema })
    const app = createApp({ env, logger, email: new EmailService(env, logger), db })
    for (const path of ['/api/v1/workspace', '/api/v1/fs', '/api/v1/terminal', '/api/v1/shell']) {
      const response = await request(app).get(path)
      expect(response.status).toBe(404)
    }
    await pool.end()
  })
})
