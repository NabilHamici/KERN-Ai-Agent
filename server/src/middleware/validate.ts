import type { NextFunction, Request, Response } from 'express'
import type { ZodType } from 'zod'
import { ValidationError } from '../utils/errors.js'

type RequestTarget = 'body' | 'query' | 'params'

export function validate(schema: ZodType, target: RequestTarget = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req[target])
    if (!parsed.success) {
      next(new ValidationError('Invalid request', parsed.error.flatten()))
      return
    }
    ;(req as Request & Record<RequestTarget, unknown>)[target] = parsed.data
    next()
  }
}
