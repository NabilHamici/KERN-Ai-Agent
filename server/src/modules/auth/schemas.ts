import { z } from 'zod'

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), {
    message: 'Password must include a letter and a number'
  })

export const deviceSchema = z.strictObject({
  deviceName: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(64),
  appVersion: z.string().trim().min(1).max(32),
  installationId: z.string().trim().min(16).max(128)
})

export const registerSchema = z
  .strictObject({
    fullName: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
    password: passwordSchema,
    confirmPassword: z.string().min(1).max(128),
    device: deviceSchema
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  })

export const loginSchema = z.strictObject({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
  device: deviceSchema
})

export const verifyEmailSchema = z.strictObject({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  device: deviceSchema
})

export const resendVerificationSchema = z.strictObject({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase())
})

export const refreshSchema = z.strictObject({
  refreshToken: z.string().min(20).max(500)
})

export const logoutSchema = z.strictObject({
  refreshToken: z.string().min(20).max(500).optional()
})

export const forgotPasswordSchema = z.strictObject({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase())
})

export const resetPasswordSchema = z
  .strictObject({
    email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
    code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
    password: passwordSchema,
    confirmPassword: z.string().min(1).max(128)
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  })
