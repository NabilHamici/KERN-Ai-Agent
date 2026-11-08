import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { AppError } from '../utils/errors.js'
import type { Logger } from '../utils/logger.js'
import { sendError } from '../utils/response.js'

export function notFoundHandler(req: Request, res: Response): void {
  sendError(res, 404, 'not_found', `Route not found: ${req.method} ${req.path}`, req.correlationId)
}

export function errorHandler(logger: Logger) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (error instanceof ZodError) {
      sendError(res, 400, 'validation_error', 'Invalid request', req.correlationId, error.flatten())
      return
    }

    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        logger.error({ err: error, correlationId: req.correlationId }, error.message)
      }
      sendError(res, error.statusCode, error.code, error.message, req.correlationId, error.details)
      return
    }

    const message = error instanceof Error ? error.message : 'Unexpected error'
    logger.error({ err: error, correlationId: req.correlationId }, message)
    sendError(res, 500, 'internal_error', 'Request failed', req.correlationId)
  }
}
