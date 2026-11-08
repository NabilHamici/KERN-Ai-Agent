import type { NextFunction, Request, Response } from 'express'
import { createCorrelationId } from '../utils/ids.js'

declare global {
  namespace Express {
    interface Request {
      correlationId: string
    }
  }
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-correlation-id')?.trim()
  const correlationId = incoming && incoming.length <= 128 ? incoming : createCorrelationId()
  req.correlationId = correlationId
  res.setHeader('x-correlation-id', correlationId)
  next()
}
