import type { NextFunction, Request, Response } from 'express'
import { and, eq, isNull } from 'drizzle-orm'
import type { Env } from '../config/env.js'
import type { Database } from '../config/database.js'
import { sessions, users } from '../db/schema/index.js'
import { UnauthorizedError } from '../utils/errors.js'
import { verifyAccessToken } from '../modules/auth/tokens.js'

export function requireAuth(env: Env, db: Database) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.header('authorization')
      if (!header?.startsWith('Bearer ')) {
        throw new UnauthorizedError('Authentication required')
      }
      const token = header.slice('Bearer '.length).trim()
      const claims = await verifyAccessToken(env, token)
      const session = await db.query.sessions.findFirst({
        where: and(eq(sessions.id, claims.sid), eq(sessions.userId, claims.sub), isNull(sessions.revokedAt))
      })
      if (!session || session.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedError('Authentication required')
      }
      const user = await db.query.users.findFirst({ where: eq(users.id, claims.sub) })
      if (!user || user.accountStatus !== 'active' || !user.emailVerifiedAt) {
        throw new UnauthorizedError('Authentication required')
      }
      req.auth = {
        userId: claims.sub,
        sessionId: claims.sid,
        deviceId: claims.did
      }
      next()
    } catch (error) {
      next(error instanceof UnauthorizedError ? error : new UnauthorizedError('Authentication required'))
    }
  }
}
