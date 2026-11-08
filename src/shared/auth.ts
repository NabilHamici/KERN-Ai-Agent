import { z } from 'zod'

export const authDeviceSchema = z.strictObject({
  deviceName: z.string().min(1).max(120),
  platform: z.string().min(1).max(64),
  appVersion: z.string().min(1).max(32),
  installationId: z.string().min(16).max(128)
})

export const authRegisterSchema = z
  .strictObject({
    fullName: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(320),
    password: z.string().min(8).max(128),
    confirmPassword: z.string().min(1).max(128)
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  })

export const authPasswordPolicySchema = z
  .string()
  .min(8)
  .max(128)
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), {
    message: 'Password must include a letter and a number'
  })

export const authLoginSchema = z.strictObject({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(128)
})

export const authVerifySchema = z.strictObject({
  email: z.string().trim().email().max(320),
  code: z.string().regex(/^\d{6}$/)
})

export const authEmailSchema = z.strictObject({
  email: z.string().trim().email().max(320)
})

export const authResetSchema = z.strictObject({
  email: z.string().trim().email().max(320),
  code: z.string().regex(/^\d{6}$/),
  password: z.string().min(8).max(128),
  confirmPassword: z.string().min(1).max(128)
})

export type AuthPublicUser = {
  id: string
  email: string
  displayName: string
  accountStatus: string
  emailVerified: boolean
}

export type AuthSessionState =
  | { status: 'loading' }
  | { status: 'unauthenticated'; reason?: string }
  | { status: 'pending_verification'; email: string; reason?: string }
  | { status: 'authenticated'; user: AuthPublicUser; offlineGrace: boolean; validatedAt: string }
  | { status: 'backend_unavailable'; reason: string; canRetry: boolean }
  | { status: 'blocked'; reason: string }

export type AuthScreen = 'login' | 'register' | 'verify' | 'forgot' | 'reset'
