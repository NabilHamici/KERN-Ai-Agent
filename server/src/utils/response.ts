import type { Response } from 'express'

export type ApiSuccess<T> = {
  ok: true
  data: T
  meta?: Record<string, unknown>
}

export type ApiFailure = {
  ok: false
  error: {
    code: string
    message: string
    details?: unknown
    correlationId?: string
  }
}

export function sendSuccess<T>(res: Response, data: T, status = 200, meta?: Record<string, unknown>): void {
  const body: ApiSuccess<T> = meta ? { ok: true, data, meta } : { ok: true, data }
  res.status(status).json(body)
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  correlationId?: string,
  details?: unknown
): void {
  const body: ApiFailure = {
    ok: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      ...(correlationId ? { correlationId } : {})
    }
  }
  res.status(status).json(body)
}
