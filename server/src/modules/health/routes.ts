import { Router } from 'express'
import type { Env } from '../../config/env.js'
import { checkDatabaseConnectivity } from '../../config/database.js'
import { smtpIsConfigured } from '../../config/env.js'
import { sendSuccess } from '../../utils/response.js'
import type { EmailService } from '../email/service.js'

export function createHealthRouter(env: Env, _email: EmailService): Router {
  const router = Router()

  router.get('/health', async (_req, res, next) => {
    try {
      const database = await checkDatabaseConnectivity()
      sendSuccess(res, {
        status: database.ok ? 'ok' : 'degraded',
        service: 'kern-server',
        version: '0.1.0',
        time: new Date().toISOString(),
        checks: {
          database: database.ok ? 'up' : 'down',
          smtp: smtpIsConfigured(env) ? 'configured' : env.EMAIL_DEV_MODE ? 'unconfigured_dev' : 'unconfigured'
        }
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/ready', async (_req, res, next) => {
    try {
      const database = await checkDatabaseConnectivity()
      if (!database.ok) {
        res.status(503).json({
          ok: false,
          error: {
            code: 'not_ready',
            message: 'Database is unavailable'
          }
        })
        return
      }

      if (!smtpIsConfigured(env) && !env.EMAIL_DEV_MODE) {
        res.status(503).json({
          ok: false,
          error: {
            code: 'not_ready',
            message: 'SMTP is unavailable'
          }
        })
        return
      }

      sendSuccess(res, {
        status: 'ready',
        time: new Date().toISOString()
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/live', (_req, res) => {
    sendSuccess(res, { status: 'alive', time: new Date().toISOString() })
  })

  return router
}
