import { Router } from 'express'
import type { Env } from '../../config/env.js'
import type { Database } from '../../config/database.js'
import { requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { AppError } from '../../utils/errors.js'
import { sendSuccess } from '../../utils/response.js'
import type { Logger } from '../../utils/logger.js'
import type { EmailService } from '../email/service.js'
import { AuthService } from './service.js'
import {
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema
} from './schemas.js'

export function createAuthRouter(deps: {
  env: Env
  db: Database
  email: EmailService
  logger: Logger
}): Router {
  const router = Router()
  const auth = new AuthService(deps.db, deps.env, deps.email, deps.logger)
  const authed = requireAuth(deps.env, deps.db)

  router.post('/register', validate(registerSchema), async (req, res, next) => {
    try {
      const result = await auth.register(req.body)
      sendSuccess(res, result, 201)
    } catch (error) {
      next(error)
    }
  })

  router.post('/verify-email', validate(verifyEmailSchema), async (req, res, next) => {
    try {
      const result = await auth.verifyEmail(req.body)
      sendSuccess(res, result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/resend-verification', validate(resendVerificationSchema), async (req, res, next) => {
    try {
      const result = await auth.resendVerification(req.body.email)
      sendSuccess(res, result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/login', validate(loginSchema), async (req, res, next) => {
    try {
      const result = await auth.login(req.body)
      sendSuccess(res, result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/refresh', validate(refreshSchema), async (req, res, next) => {
    try {
      const result = await auth.refresh(req.body.refreshToken)
      sendSuccess(res, result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/logout', validate(logoutSchema), async (req, res, next) => {
    try {
      const result = await auth.logout(req.body.refreshToken)
      sendSuccess(res, result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/logout-all', authed, async (req, res, next) => {
    try {
      const result = await auth.logoutAll(req.auth!.userId)
      sendSuccess(res, result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/forgot-password', validate(forgotPasswordSchema), async (req, res, next) => {
    try {
      const result = await auth.forgotPassword(req.body.email)
      sendSuccess(res, result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/reset-password', validate(resetPasswordSchema), async (req, res, next) => {
    try {
      const result = await auth.resetPassword(req.body)
      sendSuccess(res, result)
    } catch (error) {
      next(error)
    }
  })

  router.get('/me', authed, async (req, res, next) => {
    try {
      const result = await auth.me(req.auth!.userId)
      sendSuccess(res, result)
    } catch (error) {
      next(error)
    }
  })

  router.get('/devices', authed, async (req, res, next) => {
    try {
      const devices = await auth.listDevices(req.auth!.userId)
      sendSuccess(
        res,
        devices.map((device) => ({
          id: device.id,
          deviceName: device.deviceName,
          platform: device.platform,
          appVersion: device.appVersion,
          lastSeenAt: device.lastSeenAt,
          createdAt: device.createdAt,
          current: device.id === req.auth!.deviceId
        }))
      )
    } catch (error) {
      next(error)
    }
  })

  router.delete('/devices/:id', authed, async (req, res, next) => {
    try {
      const deviceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
      if (!deviceId) {
        throw new AppError(400, 'bad_request', 'Device id required')
      }
      const result = await auth.revokeDevice(req.auth!.userId, deviceId)
      sendSuccess(res, result)
    } catch (error) {
      next(error)
    }
  })

  return router
}
