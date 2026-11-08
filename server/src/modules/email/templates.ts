export type EmailTemplate = {
  subject: string
  text: string
  html: string
}

function wrapHtml(title: string, body: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#0f1218;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f1218;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#161922;border:1px solid #2a3140;border-radius:12px;padding:28px;">
            <tr>
              <td style="font-size:20px;font-weight:650;letter-spacing:0.04em;color:#c084fc;">KERN</td>
            </tr>
            <tr>
              <td style="padding-top:18px;font-size:16px;line-height:1.55;color:#e2e8f0;">${body}</td>
            </tr>
            <tr>
              <td style="padding-top:28px;font-size:12px;color:#94a3b8;">This message was sent by KERN. If you did not request it, you can ignore this email.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function verificationEmail(input: { displayName: string; verifyUrl: string }): EmailTemplate {
  const subject = 'Verify your KERN email'
  const text = [
    `Hello ${input.displayName},`,
    '',
    'Confirm your KERN account email by opening this link:',
    input.verifyUrl,
    '',
    'If you did not create a KERN account, ignore this message.'
  ].join('\n')
  const html = wrapHtml(
    subject,
    `<p>Hello ${escapeHtml(input.displayName)},</p>
     <p>Confirm your KERN account email:</p>
     <p><a href="${escapeHtml(input.verifyUrl)}" style="color:#c084fc;">Verify email</a></p>
     <p style="word-break:break-all;font-size:12px;color:#94a3b8;">${escapeHtml(input.verifyUrl)}</p>`
  )
  return { subject, text, html }
}

export function passwordResetEmail(input: { displayName: string; resetUrl: string }): EmailTemplate {
  const subject = 'Reset your KERN password'
  const text = [
    `Hello ${input.displayName},`,
    '',
    'Reset your KERN password using this single-use link:',
    input.resetUrl,
    '',
    'If you did not request a password reset, ignore this message.'
  ].join('\n')
  const html = wrapHtml(
    subject,
    `<p>Hello ${escapeHtml(input.displayName)},</p>
     <p>Reset your KERN password with this single-use link:</p>
     <p><a href="${escapeHtml(input.resetUrl)}" style="color:#c084fc;">Reset password</a></p>
     <p style="word-break:break-all;font-size:12px;color:#94a3b8;">${escapeHtml(input.resetUrl)}</p>`
  )
  return { subject, text, html }
}

export function otpEmail(input: { displayName: string; code: string }): EmailTemplate {
  const subject = 'Your KERN verification code'
  const text = [
    `Hello ${input.displayName},`,
    '',
    `Your KERN email verification code is: ${input.code}`,
    '',
    'This code expires in 10 minutes.',
    'If you did not create a KERN account, ignore this message.'
  ].join('\n')
  const html = wrapHtml(
    subject,
    `<p>Hello ${escapeHtml(input.displayName)},</p>
     <p>Your KERN email verification code is:</p>
     <p style="font-size:28px;letter-spacing:0.28em;font-weight:700;color:#c084fc;">${escapeHtml(input.code)}</p>
     <p>This code expires in 10 minutes.</p>`
  )
  return { subject, text, html }
}

export function passwordResetOtpEmail(input: { displayName: string; code: string }): EmailTemplate {
  const subject = 'Your KERN password reset code'
  const text = [
    `Hello ${input.displayName},`,
    '',
    `Your KERN password reset code is: ${input.code}`,
    '',
    'This code expires in 10 minutes.',
    'If you did not request a password reset, ignore this message.'
  ].join('\n')
  const html = wrapHtml(
    subject,
    `<p>Hello ${escapeHtml(input.displayName)},</p>
     <p>Your KERN password reset code is:</p>
     <p style="font-size:28px;letter-spacing:0.28em;font-weight:700;color:#c084fc;">${escapeHtml(input.code)}</p>
     <p>This code expires in 10 minutes.</p>`
  )
  return { subject, text, html }
}

export function newDeviceEmail(input: {
  displayName: string
  deviceName: string
  platform: string
  appVersion: string
}): EmailTemplate {
  const subject = 'New KERN device signed in'
  const text = [
    `Hello ${input.displayName},`,
    '',
    'A new device was registered for your KERN account:',
    `Device: ${input.deviceName}`,
    `Platform: ${input.platform}`,
    `App version: ${input.appVersion}`,
    '',
    'If this was not you, revoke the device from your account settings once authentication is available.'
  ].join('\n')
  const html = wrapHtml(
    subject,
    `<p>Hello ${escapeHtml(input.displayName)},</p>
     <p>A new device was registered for your KERN account:</p>
     <ul>
       <li><strong>Device:</strong> ${escapeHtml(input.deviceName)}</li>
       <li><strong>Platform:</strong> ${escapeHtml(input.platform)}</li>
       <li><strong>App version:</strong> ${escapeHtml(input.appVersion)}</li>
     </ul>`
  )
  return { subject, text, html }
}
