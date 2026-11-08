import { and, desc, eq, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Env } from '../../config/env.js'
import type { Database } from '../../config/database.js'
import {
  emailVerificationOtps,
  passwordResetOtps,
  sessions,
  userDevices,
  users,
  type User
} from '../../db/schema/index.js'
import { AppError } from '../../utils/errors.js'
import type { Logger } from '../../utils/logger.js'
import type { EmailService } from '../email/service.js'
import { otpEmail, passwordResetOtpEmail } from '../email/templates.js'
import {
  generateOtpCode,
  generateRefreshToken,
  hashOtp,
  hashPassword,
  hashRefreshToken,
  safeEqualHex,
  verifyPassword
} from './crypto.js'
import { signAccessToken } from './tokens.js'

const OTP_TTL_MS = 10 * 60 * 1000
const RESEND_COOLDOWN_MS = 60_000
const MAX_OTP_ATTEMPTS = 5

export type PublicUser = {
  id: string
  email: string
  displayName: string
  accountStatus: string
  emailVerified: boolean
}

export type AuthSessionBundle = {
  accessToken: string
  refreshToken: string
  accessTokenExpiresIn: number
  user: PublicUser
  deviceId: string
  sessionId: string
}

type DeviceInput = {
  deviceName: string
  platform: string
  appVersion: string
  installationId: string
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly email: EmailService,
    private readonly logger: Logger
  ) {}

  toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      accountStatus: user.accountStatus,
      emailVerified: Boolean(user.emailVerifiedAt)
    }
  }

  async register(input: {
    fullName: string
    email: string
    password: string
    device: DeviceInput
  }): Promise<{ user: PublicUser; verificationRequired: true; emailDeliveryFailed?: true }> {
    const existing = await this.db.query.users.findFirst({ where: eq(users.email, input.email) })
    if (existing) {
      // Generic-ish conflict without enabling easy enumeration of verified accounts via different codes.
      throw new AppError(409, 'registration_failed', 'Unable to create account with that email')
    }

    const passwordHash = await hashPassword(input.password)
    const [user] = await this.db
      .insert(users)
      .values({
        email: input.email,
        displayName: input.fullName,
        passwordHash,
        accountType: 'personal',
        accountStatus: 'pending_verification'
      })
      .returning()
    if (!user) {
      throw new AppError(500, 'registration_failed', 'Unable to create account')
    }

    await this.upsertDevice(user.id, input.device)
    try {
      await this.issueVerificationOtp(user)
    } catch (error) {
      if (error instanceof AppError && error.code === 'email_delivery_failed') {
        return {
          user: this.toPublicUser(user),
          verificationRequired: true as const,
          emailDeliveryFailed: true as const
        }
      }
      throw error
    }

    return { user: this.toPublicUser(user), verificationRequired: true as const }
  }

  async resendVerification(email: string): Promise<{ sent: true }> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email) })
    // Always generic success path timing: if missing/verified, still return success.
    if (!user || user.emailVerifiedAt || user.accountStatus === 'suspended') {
      return { sent: true }
    }
    await this.issueVerificationOtp(user)
    return { sent: true }
  }

  async verifyEmail(input: { email: string; code: string; device: DeviceInput }): Promise<AuthSessionBundle> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, input.email) })
    if (!user || user.accountStatus === 'suspended') {
      throw new AppError(400, 'invalid_code', 'Invalid or expired verification code')
    }
    if (user.emailVerifiedAt && user.accountStatus === 'active') {
      return this.createSession(user, input.device)
    }

    const otp = await this.db.query.emailVerificationOtps.findFirst({
      where: and(eq(emailVerificationOtps.userId, user.id), isNull(emailVerificationOtps.consumedAt)),
      orderBy: [desc(emailVerificationOtps.createdAt)]
    })
    if (!otp || otp.expiresAt.getTime() < Date.now()) {
      throw new AppError(400, 'invalid_code', 'Invalid or expired verification code')
    }
    if (otp.attemptCount >= MAX_OTP_ATTEMPTS) {
      throw new AppError(429, 'too_many_attempts', 'Too many verification attempts. Request a new code.')
    }

    const matches = safeEqualHex(otp.codeHash, hashOtp(input.code))
    if (!matches) {
      await this.db
        .update(emailVerificationOtps)
        .set({ attemptCount: otp.attemptCount + 1 })
        .where(eq(emailVerificationOtps.id, otp.id))
      throw new AppError(400, 'invalid_code', 'Invalid or expired verification code')
    }

    const now = new Date()
    await this.db.update(emailVerificationOtps).set({ consumedAt: now }).where(eq(emailVerificationOtps.id, otp.id))
    const [updated] = await this.db
      .update(users)
      .set({
        emailVerifiedAt: now,
        accountStatus: 'active',
        updatedAt: now
      })
      .where(eq(users.id, user.id))
      .returning()
    if (!updated) {
      throw new AppError(500, 'verification_failed', 'Unable to verify email')
    }
    return this.createSession(updated, input.device)
  }

  async login(input: { email: string; password: string; device: DeviceInput }): Promise<AuthSessionBundle | { verificationRequired: true; email: string }> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, input.email) })
    if (!user?.passwordHash) {
      throw new AppError(401, 'invalid_credentials', 'Invalid email or password')
    }
    const ok = await verifyPassword(user.passwordHash, input.password)
    if (!ok) {
      throw new AppError(401, 'invalid_credentials', 'Invalid email or password')
    }
    if (user.accountStatus === 'suspended') {
      throw new AppError(403, 'account_suspended', 'This account has been suspended')
    }
    if (!user.emailVerifiedAt || user.accountStatus === 'pending_verification') {
      return { verificationRequired: true, email: user.email }
    }
    await this.db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id))
    return this.createSession(user, input.device)
  }

  async refresh(refreshToken: string): Promise<AuthSessionBundle> {
    const tokenHash = hashRefreshToken(refreshToken)
    const session = await this.db.query.sessions.findFirst({ where: eq(sessions.refreshTokenHash, tokenHash) })
    if (!session) {
      throw new AppError(401, 'invalid_session', 'Session is invalid')
    }
    if (session.revokedAt) {
      // Refresh token reuse: revoke the entire family.
      await this.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)))
      throw new AppError(401, 'invalid_session', 'Session is invalid')
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw new AppError(401, 'invalid_session', 'Session is invalid')
    }
    const user = await this.db.query.users.findFirst({ where: eq(users.id, session.userId) })
    if (!user || user.accountStatus !== 'active' || !user.emailVerifiedAt) {
      throw new AppError(401, 'invalid_session', 'Session is invalid')
    }
    const device = await this.db.query.userDevices.findFirst({ where: eq(userDevices.id, session.deviceId) })
    if (!device || device.revokedAt) {
      throw new AppError(401, 'invalid_session', 'Session is invalid')
    }

    const now = new Date()
    await this.db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, session.id))
    const nextRefresh = generateRefreshToken()
    const [next] = await this.db
      .insert(sessions)
      .values({
        userId: user.id,
        deviceId: device.id,
        refreshTokenHash: hashRefreshToken(nextRefresh),
        familyId: session.familyId,
        expiresAt: new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
      })
      .returning()
    if (!next) {
      throw new AppError(500, 'session_failed', 'Unable to refresh session')
    }
    await this.db.update(sessions).set({ replacedBySessionId: next.id }).where(eq(sessions.id, session.id))
    await this.db.update(userDevices).set({ lastSeenAt: now }).where(eq(userDevices.id, device.id))

    const accessToken = await signAccessToken(this.env, { sub: user.id, sid: next.id, did: device.id })
    return {
      accessToken,
      refreshToken: nextRefresh,
      accessTokenExpiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
      user: this.toPublicUser(user),
      deviceId: device.id,
      sessionId: next.id
    }
  }

  async logout(refreshToken?: string, accessUserId?: string): Promise<{ loggedOut: true }> {
    if (refreshToken) {
      const tokenHash = hashRefreshToken(refreshToken)
      await this.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.refreshTokenHash, tokenHash), isNull(sessions.revokedAt)))
    } else if (accessUserId) {
      // No-op without refresh: caller may only clear local credentials.
    }
    return { loggedOut: true }
  }

  async logoutAll(userId: string): Promise<{ loggedOut: true }> {
    const now = new Date()
    await this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    return { loggedOut: true }
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) })
    if (!user || user.accountStatus === 'suspended') {
      throw new AppError(401, 'unauthorized', 'Authentication required')
    }
    return this.toPublicUser(user)
  }

  async listDevices(userId: string) {
    return this.db.query.userDevices.findMany({
      where: and(eq(userDevices.userId, userId), isNull(userDevices.revokedAt))
    })
  }

  async revokeDevice(userId: string, deviceId: string): Promise<{ revoked: true }> {
    const device = await this.db.query.userDevices.findFirst({
      where: and(eq(userDevices.id, deviceId), eq(userDevices.userId, userId), isNull(userDevices.revokedAt))
    })
    if (!device) {
      throw new AppError(404, 'not_found', 'Device not found')
    }
    const now = new Date()
    await this.db.update(userDevices).set({ revokedAt: now }).where(eq(userDevices.id, deviceId))
    await this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.deviceId, deviceId), isNull(sessions.revokedAt)))
    return { revoked: true }
  }

  async forgotPassword(email: string): Promise<{ accepted: true }> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email) })
    if (user && user.accountStatus !== 'suspended' && user.passwordHash) {
      await this.issuePasswordResetOtp(user)
    }
    return { accepted: true }
  }

  async resetPassword(input: { email: string; code: string; password: string }): Promise<{ reset: true }> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, input.email) })
    if (!user) {
      throw new AppError(400, 'invalid_code', 'Invalid or expired reset code')
    }
    const otp = await this.db.query.passwordResetOtps.findFirst({
      where: and(eq(passwordResetOtps.userId, user.id), isNull(passwordResetOtps.consumedAt)),
      orderBy: [desc(passwordResetOtps.createdAt)]
    })
    if (!otp || otp.expiresAt.getTime() < Date.now()) {
      throw new AppError(400, 'invalid_code', 'Invalid or expired reset code')
    }
    if (otp.attemptCount >= MAX_OTP_ATTEMPTS) {
      throw new AppError(429, 'too_many_attempts', 'Too many attempts. Request a new code.')
    }
    const matches = safeEqualHex(otp.codeHash, hashOtp(input.code))
    if (!matches) {
      await this.db
        .update(passwordResetOtps)
        .set({ attemptCount: otp.attemptCount + 1 })
        .where(eq(passwordResetOtps.id, otp.id))
      throw new AppError(400, 'invalid_code', 'Invalid or expired reset code')
    }

    const now = new Date()
    await this.db.update(passwordResetOtps).set({ consumedAt: now }).where(eq(passwordResetOtps.id, otp.id))
    const passwordHash = await hashPassword(input.password)
    await this.db.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, user.id))
    await this.logoutAll(user.id)
    return { reset: true }
  }

  private async issueVerificationOtp(user: User): Promise<void> {
    const latest = await this.db.query.emailVerificationOtps.findFirst({
      where: and(eq(emailVerificationOtps.userId, user.id), isNull(emailVerificationOtps.consumedAt)),
      orderBy: [desc(emailVerificationOtps.createdAt)]
    })
    if (latest && Date.now() - latest.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new AppError(429, 'resend_cooldown', 'Please wait before requesting another code')
    }

    const code = generateOtpCode()
    const now = new Date()
    if (latest) {
      await this.db.update(emailVerificationOtps).set({ consumedAt: now }).where(eq(emailVerificationOtps.id, latest.id))
    }
    await this.db.insert(emailVerificationOtps).values({
      userId: user.id,
      codeHash: hashOtp(code),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      lastSentAt: now
    })

    const result = await this.email.send({
      to: user.email,
      template: otpEmail({ displayName: user.displayName, code })
    })
    if (!result.delivered) {
      this.logger.error({ email: user.email, mode: result.mode }, 'Verification email was not delivered')
      throw new AppError(502, 'email_delivery_failed', 'Unable to send verification email. Try again shortly.')
    }
  }

  private async issuePasswordResetOtp(user: User): Promise<void> {
    const latest = await this.db.query.passwordResetOtps.findFirst({
      where: and(eq(passwordResetOtps.userId, user.id), isNull(passwordResetOtps.consumedAt)),
      orderBy: [desc(passwordResetOtps.createdAt)]
    })
    if (latest && Date.now() - latest.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new AppError(429, 'resend_cooldown', 'Please wait before requesting another code')
    }
    const code = generateOtpCode()
    const now = new Date()
    if (latest) {
      await this.db.update(passwordResetOtps).set({ consumedAt: now }).where(eq(passwordResetOtps.id, latest.id))
    }
    await this.db.insert(passwordResetOtps).values({
      userId: user.id,
      codeHash: hashOtp(code),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      lastSentAt: now
    })
    const result = await this.email.send({
      to: user.email,
      template: passwordResetOtpEmail({ displayName: user.displayName, code })
    })
    if (!result.delivered) {
      throw new AppError(502, 'email_delivery_failed', 'Unable to send reset email. Try again shortly.')
    }
  }

  private async upsertDevice(userId: string, device: DeviceInput) {
    const existing = await this.db.query.userDevices.findFirst({
      where: eq(userDevices.installationId, device.installationId)
    })
    if (existing) {
      if (existing.userId !== userId) {
        throw new AppError(409, 'device_conflict', 'This device is already linked to another account')
      }
      const [updated] = await this.db
        .update(userDevices)
        .set({
          deviceName: device.deviceName,
          platform: device.platform,
          appVersion: device.appVersion,
          lastSeenAt: new Date(),
          revokedAt: null
        })
        .where(eq(userDevices.id, existing.id))
        .returning()
      return updated!
    }
    const [created] = await this.db
      .insert(userDevices)
      .values({
        userId,
        deviceName: device.deviceName,
        platform: device.platform,
        appVersion: device.appVersion,
        installationId: device.installationId
      })
      .returning()
    return created!
  }

  private async createSession(user: User, deviceInput: DeviceInput): Promise<AuthSessionBundle> {
    const device = await this.upsertDevice(user.id, deviceInput)
    const refreshToken = generateRefreshToken()
    const familyId = randomUUID()
    const [session] = await this.db
      .insert(sessions)
      .values({
        userId: user.id,
        deviceId: device.id,
        refreshTokenHash: hashRefreshToken(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
      })
      .returning()
    if (!session) {
      throw new AppError(500, 'session_failed', 'Unable to create session')
    }
    const accessToken = await signAccessToken(this.env, { sub: user.id, sid: session.id, did: device.id })
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
      user: this.toPublicUser(user),
      deviceId: device.id,
      sessionId: session.id
    }
  }
}
