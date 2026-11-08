export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: unknown

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details?: unknown) {
    super(400, 'validation_error', message, details)
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'not_found', message)
    this.name = 'NotFoundError'
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'unauthorized', message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'forbidden', message)
    this.name = 'ForbiddenError'
  }
}
