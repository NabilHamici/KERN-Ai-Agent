import { SignJWT, jwtVerify } from 'jose'
import type { Env } from '../../config/env.js'

export type AccessClaims = {
  sub: string
  sid: string
  did: string
}

export async function signAccessToken(env: Env, claims: AccessClaims): Promise<string> {
  const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET)
  return new SignJWT({ sid: claims.sid, did: claims.did })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .setIssuer('kern')
    .sign(secret)
}

export async function verifyAccessToken(env: Env, token: string): Promise<AccessClaims> {
  const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET)
  const { payload } = await jwtVerify(token, secret, { issuer: 'kern' })
  const sub = payload.sub
  const sid = typeof payload.sid === 'string' ? payload.sid : null
  const did = typeof payload.did === 'string' ? payload.did : null
  if (!sub || !sid || !did) {
    throw new Error('Invalid access token')
  }
  return { sub, sid, did }
}
