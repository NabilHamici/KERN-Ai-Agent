import nodemailer, { type Transporter } from 'nodemailer'
import type { Env } from '../../config/env.js'
import { smtpIsConfigured } from '../../config/env.js'
import { AppError } from '../../utils/errors.js'
import type { Logger } from '../../utils/logger.js'
import { newDeviceEmail, passwordResetEmail, type EmailTemplate, verificationEmail } from './templates.js'

export type SendEmailInput = {
  to: string
  template: EmailTemplate
}

export type SendEmailResult =
  | { delivered: true; messageId: string; mode: 'smtp' }
  | { delivered: false; mode: 'dev_log'; reason: string }

export class EmailService {
  private transporter: Transporter | null = null

  constructor(
    private readonly env: Env,
    private readonly logger: Logger
  ) {}

  isConfigured(): boolean {
    return smtpIsConfigured(this.env)
  }

  private getTransporter(): Transporter {
    if (!this.isConfigured()) {
      throw new AppError(503, 'smtp_unconfigured', 'SMTP is not configured')
    }
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.env.SMTP_HOST,
        port: this.env.SMTP_PORT,
        secure: this.env.SMTP_SECURE,
        auth: this.env.SMTP_USER
          ? {
              user: this.env.SMTP_USER,
              pass: this.env.SMTP_PASS
            }
          : undefined
      })
    }
    return this.transporter
  }

  async verifyConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isConfigured()) {
      if (this.env.EMAIL_DEV_MODE) {
        return { ok: false, error: 'SMTP is not configured (development mode allows soft failure)' }
      }
      return { ok: false, error: 'SMTP is not configured' }
    }
    try {
      await this.getTransporter().verify()
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'SMTP verification failed'
      }
    }
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.isConfigured()) {
      if (this.env.EMAIL_DEV_MODE) {
        this.logger.info(
          {
            email: {
              to: input.to,
              subject: input.template.subject,
              mode: 'dev_log'
            }
          },
          'Email not delivered: SMTP unconfigured in development mode'
        )
        return {
          delivered: false,
          mode: 'dev_log',
          reason: 'SMTP is not configured'
        }
      }
      throw new AppError(503, 'smtp_unconfigured', 'SMTP is not configured')
    }

    try {
      const info = await this.getTransporter().sendMail({
        from: `"${this.env.SMTP_FROM_NAME}" <${this.env.SMTP_FROM_EMAIL}>`,
        to: input.to,
        subject: input.template.subject,
        text: input.template.text,
        html: input.template.html
      })
      this.logger.info(
        {
          email: {
            to: input.to,
            subject: input.template.subject,
            messageId: info.messageId,
            mode: 'smtp'
          }
        },
        'Email accepted by SMTP transport'
      )
      return { delivered: true, messageId: info.messageId, mode: 'smtp' }
    } catch (error) {
      this.logger.error(
        {
          email: {
            to: input.to,
            subject: input.template.subject,
            mode: 'smtp'
          },
          err: error instanceof Error ? { message: error.message, name: error.name } : error
        },
        'Email delivery failed'
      )
      throw new AppError(502, 'smtp_delivery_failed', 'Email could not be delivered')
    }
  }

  renderVerification(displayName: string, token: string): EmailTemplate {
    const verifyUrl = new URL('/verify-email', this.env.APP_URL)
    verifyUrl.searchParams.set('token', token)
    return verificationEmail({ displayName, verifyUrl: verifyUrl.toString() })
  }

  renderPasswordReset(displayName: string, token: string): EmailTemplate {
    const resetUrl = new URL('/reset-password', this.env.APP_URL)
    resetUrl.searchParams.set('token', token)
    return passwordResetEmail({ displayName, resetUrl: resetUrl.toString() })
  }

  renderNewDevice(input: {
    displayName: string
    deviceName: string
    platform: string
    appVersion: string
  }): EmailTemplate {
    return newDeviceEmail(input)
  }
}
