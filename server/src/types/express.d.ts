export {}

declare global {
  namespace Express {
    interface Request {
      correlationId: string
      /**
       * Populated only after Phase 2F authentication middleware verifies a session.
       * Never accept a client-supplied user id as authenticated identity.
       */
      auth?: {
        userId: string
        sessionId: string
        deviceId: string
      }
    }
  }
}
