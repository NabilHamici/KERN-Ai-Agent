import cors from 'cors'
import express, { type Express } from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import type { Env } from './config/env.js'
import type { Database } from './config/database.js'
import { correlationMiddleware } from './middleware/correlation.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { createAuthRouter } from './modules/auth/routes.js'
import { EmailService } from './modules/email/service.js'
import { createHealthRouter } from './modules/health/routes.js'
import type { Logger } from './utils/logger.js'

export type AppDependencies = {
  env: Env
  logger: Logger
  email: EmailService
  db: Database
}

export function createApp(deps: AppDependencies): Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  app.use(correlationMiddleware)
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req) => req.correlationId,
      customProps: (req) => ({ correlationId: req.correlationId }),
      serializers: {
        req(request) {
          return {
            id: request.id,
            method: request.method,
            url: request.url
          }
        }
      }
    })
  )
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false
    })
  )
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          callback(null, true)
          return
        }
        if (deps.env.CORS_ORIGINS.includes(origin)) {
          callback(null, true)
          return
        }
        callback(null, false)
      },
      credentials: true
    })
  )
  app.use(express.json({ limit: '100kb' }))
  app.use(express.urlencoded({ extended: false, limit: '100kb' }))

  const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error: {
        code: 'rate_limited',
        message: 'Too many requests'
      }
    }
  })

  app.use('/api/v1/auth', authRateLimit, createAuthRouter(deps))
  app.use('/api/v1', createHealthRouter(deps.env, deps.email))

  app.use(notFoundHandler)
  app.use(errorHandler(deps.logger))
  return app
}
