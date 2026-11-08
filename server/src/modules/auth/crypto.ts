import { createHash, randomInt, randomBytes, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id })
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(`kern-otp:${code}`).digest('hex')
}

export function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(a, b)
}

export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url')
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(`kern-refresh:${token}`).digest('hex')
}

export function generateInstallationFallback(): string {
  return randomBytes(16).toString('hex')
}
