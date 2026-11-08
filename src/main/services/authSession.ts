import { app, safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_KERN_API_URL } from '../../shared/api.ts'
import type { AuthPublicUser, AuthSessionState } from '../../shared/auth.ts'

type StoredSession = {
  refreshToken: string
  accessToken: string
  accessExpiresAt: number
  user: AuthPublicUser
  deviceId: string
  sessionId: string
  lastValidatedAt: number
}

type ApiSuccess<T> = { ok: true; data: T }
type ApiFailure = { ok: false; error: { code: string; message: string } }

const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export class AuthSessionService {
  private session: StoredSession | null = null
  private readonly installationId: string
  private readonly apiBase: string
  private readonly vaultPath: string
  private readonly metaPath: string

  constructor(userData: string) {
    this.apiBase = (process.env.KERN_API_URL ?? DEFAULT_KERN_API_URL).replace(/\/$/, '')
    this.vaultPath = path.join(userData, 'auth-session.bin')
    this.metaPath = path.join(userData, 'auth-meta.json')
    this.installationId = this.loadOrCreateInstallationId(userData)
  }

  devicePayload() {
    return {
      deviceName: `${process.platform}-${app.getName()}`,
      platform: process.platform,
      appVersion: app.getVersion(),
      installationId: this.installationId
    }
  }

  isAcceptanceBypass(): boolean {
    return process.env.KERN_ACCEPTANCE === '1' || process.env.KERN_ACCEPTANCE === 'verify'
  }

  isAuthenticated(): boolean {
    if (this.isAcceptanceBypass()) {
      return true
    }
    return Boolean(this.session?.user.emailVerified && this.session.user.accountStatus === 'active')
  }

  currentUser(): AuthPublicUser | null {
    return this.session?.user ?? null
  }

  async bootstrap(): Promise<AuthSessionState> {
    if (this.isAcceptanceBypass()) {
      return {
        status: 'authenticated',
        user: {
          id: 'acceptance',
          email: 'acceptance@kern.local',
          displayName: 'Acceptance',
          accountStatus: 'active',
          emailVerified: true
        },
        offlineGrace: false,
        validatedAt: new Date().toISOString()
      }
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return { status: 'blocked', reason: 'Secure credential storage is unavailable on this system.' }
    }

    this.session = this.readVault()
    if (!this.session) {
      return { status: 'unauthenticated' }
    }

    try {
      if (this.session.accessExpiresAt <= Date.now() + 30_000) {
        await this.refresh()
      } else {
        await this.validateMe()
      }
      return {
        status: 'authenticated',
        user: this.session!.user,
        offlineGrace: false,
        validatedAt: new Date(this.session!.lastValidatedAt).toISOString()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Backend unavailable'
      if (/suspended|revoked|invalid_session|unauthorized/i.test(message)) {
        this.clearVault()
        this.session = null
        return { status: 'unauthenticated', reason: message }
      }
      const age = Date.now() - this.session.lastValidatedAt
      if (age <= OFFLINE_GRACE_MS) {
        return {
          status: 'authenticated',
          user: this.session.user,
          offlineGrace: true,
          validatedAt: new Date(this.session.lastValidatedAt).toISOString()
        }
      }
      return {
        status: 'backend_unavailable',
        reason: 'Unable to reach the KERN account service. Connect to the internet to continue.',
        canRetry: true
      }
    }
  }

  async register(input: {
    fullName: string
    email: string
    password: string
    confirmPassword: string
  }): Promise<AuthSessionState> {
    const data = await this.api<{
      user: AuthPublicUser
      verificationRequired: true
      emailDeliveryFailed?: boolean
    }>('/api/v1/auth/register', {
      ...input,
      email: input.email.trim().toLowerCase(),
      device: this.devicePayload()
    })
    return {
      status: 'pending_verification',
      email: data.user.email,
      reason: data.emailDeliveryFailed
        ? 'Account created, but the verification email could not be delivered. Wait a minute, then resend the code.'
        : undefined
    }
  }

  async login(input: { email: string; password: string }): Promise<AuthSessionState> {
    const data = await this.api<
      | {
          accessToken: string
          refreshToken: string
          accessTokenExpiresIn: number
          user: AuthPublicUser
          deviceId: string
          sessionId: string
        }
      | { verificationRequired: true; email: string }
    >('/api/v1/auth/login', {
      email: input.email.trim().toLowerCase(),
      password: input.password,
      device: this.devicePayload()
    })
    if ('verificationRequired' in data) {
      return { status: 'pending_verification', email: data.email }
    }
    this.persistBundle(data)
    return {
      status: 'authenticated',
      user: data.user,
      offlineGrace: false,
      validatedAt: new Date().toISOString()
    }
  }

  async verifyEmail(input: { email: string; code: string }): Promise<AuthSessionState> {
    const data = await this.api<{
      accessToken: string
      refreshToken: string
      accessTokenExpiresIn: number
      user: AuthPublicUser
      deviceId: string
      sessionId: string
    }>('/api/v1/auth/verify-email', {
      email: input.email.trim().toLowerCase(),
      code: input.code,
      device: this.devicePayload()
    })
    this.persistBundle(data)
    return {
      status: 'authenticated',
      user: data.user,
      offlineGrace: false,
      validatedAt: new Date().toISOString()
    }
  }

  async resendVerification(email: string): Promise<{ sent: true }> {
    return this.api('/api/v1/auth/resend-verification', { email: email.trim().toLowerCase() })
  }

  async forgotPassword(email: string): Promise<{ accepted: true }> {
    return this.api('/api/v1/auth/forgot-password', { email: email.trim().toLowerCase() })
  }

  async resetPassword(input: {
    email: string
    code: string
    password: string
    confirmPassword: string
  }): Promise<{ reset: true }> {
    return this.api('/api/v1/auth/reset-password', {
      email: input.email.trim().toLowerCase(),
      code: input.code,
      password: input.password,
      confirmPassword: input.confirmPassword
    })
  }

  async logout(): Promise<AuthSessionState> {
    try {
      if (this.session?.refreshToken) {
        await this.api('/api/v1/auth/logout', { refreshToken: this.session.refreshToken })
      }
    } catch {
      // Clear local credentials even if network fails.
    }
    this.clearVault()
    this.session = null
    return { status: 'unauthenticated' }
  }

  async logoutAll(): Promise<AuthSessionState> {
    await this.authedApi('/api/v1/auth/logout-all', { method: 'POST', body: {} })
    this.clearVault()
    this.session = null
    return { status: 'unauthenticated' }
  }

  async me(): Promise<AuthPublicUser> {
    return this.authedApi<AuthPublicUser>('/api/v1/auth/me', { method: 'GET' })
  }

  async listDevices() {
    return this.authedApi<
      Array<{
        id: string
        deviceName: string
        platform: string
        appVersion: string
        lastSeenAt: string
        createdAt: string
        current: boolean
      }>
    >('/api/v1/auth/devices', { method: 'GET' })
  }

  private async refresh(): Promise<void> {
    if (!this.session) {
      throw new Error('invalid_session')
    }
    const data = await this.api<{
      accessToken: string
      refreshToken: string
      accessTokenExpiresIn: number
      user: AuthPublicUser
      deviceId: string
      sessionId: string
    }>('/api/v1/auth/refresh', { refreshToken: this.session.refreshToken })
    this.persistBundle(data)
  }

  private async validateMe(): Promise<void> {
    const user = await this.authedApi<AuthPublicUser>('/api/v1/auth/me', { method: 'GET' })
    if (!this.session) {
      throw new Error('invalid_session')
    }
    this.session = {
      ...this.session,
      user,
      lastValidatedAt: Date.now()
    }
    this.writeVault(this.session)
  }

  private persistBundle(data: {
    accessToken: string
    refreshToken: string
    accessTokenExpiresIn: number
    user: AuthPublicUser
    deviceId: string
    sessionId: string
  }): void {
    this.session = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accessExpiresAt: Date.now() + data.accessTokenExpiresIn * 1000,
      user: data.user,
      deviceId: data.deviceId,
      sessionId: data.sessionId,
      lastValidatedAt: Date.now()
    }
    this.writeVault(this.session)
  }

  private async authedApi<T>(pathname: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    if (!this.session) {
      throw new Error('unauthorized')
    }
    if (this.session.accessExpiresAt <= Date.now() + 15_000) {
      await this.refresh()
    }
    return this.api<T>(pathname, init.body, {
      method: init.method,
      authorization: `Bearer ${this.session!.accessToken}`
    })
  }

  private async api<T>(
    pathname: string,
    body?: unknown,
    init?: { method?: string; authorization?: string }
  ): Promise<T> {
    const method = init?.method ?? 'POST'
    let response: Response
    try {
      response = await fetch(`${this.apiBase}${pathname}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(init?.authorization ? { authorization: init.authorization } : {})
        },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
      })
    } catch {
      throw new Error('backend_unavailable')
    }
    const json = (await response.json()) as ApiSuccess<T> | ApiFailure
    if (!json || typeof json !== 'object' || !('ok' in json)) {
      throw new Error('Request failed')
    }
    if (!json.ok) {
      throw new Error(json.error.message || json.error.code || 'Request failed')
    }
    return json.data
  }

  private loadOrCreateInstallationId(userData: string): string {
    const file = path.join(userData, 'installation-id')
    try {
      if (fs.existsSync(file)) {
        const value = fs.readFileSync(file, 'utf8').trim()
        if (value.length >= 16) {
          return value
        }
      }
    } catch {
      // recreate below
    }
    const value = createHash('sha256').update(`${randomUUID()}:${Date.now()}`).digest('hex')
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(file, value, 'utf8')
    return value
  }

  private writeVault(session: StoredSession): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is unavailable on this system')
    }
    const payload = Buffer.from(JSON.stringify(session), 'utf8')
    const encrypted = safeStorage.encryptString(payload.toString('base64'))
    fs.writeFileSync(this.vaultPath, encrypted)
    fs.writeFileSync(
      this.metaPath,
      JSON.stringify({ lastValidatedAt: session.lastValidatedAt, userId: session.user.id }, null, 2)
    )
  }

  private readVault(): StoredSession | null {
    try {
      if (!fs.existsSync(this.vaultPath) || !safeStorage.isEncryptionAvailable()) {
        return null
      }
      const encrypted = fs.readFileSync(this.vaultPath)
      const decoded = Buffer.from(safeStorage.decryptString(encrypted), 'base64').toString('utf8')
      return JSON.parse(decoded) as StoredSession
    } catch {
      return null
    }
  }

  private clearVault(): void {
    for (const file of [this.vaultPath, this.metaPath]) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file)
        }
      } catch {
        // ignore
      }
    }
  }
}
