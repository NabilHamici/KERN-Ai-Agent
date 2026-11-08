import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AuthScreen, AuthSessionState } from '../../../shared/auth'
import kernLogo from '../assets/kern-logo.svg'

type AuthShellProps = {
  initial: AuthSessionState
  onAuthenticated: (state: Extract<AuthSessionState, { status: 'authenticated' }>) => void
}

type FieldErrors = Record<string, string>

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 3l18 18M10.5 10.7a2.5 2.5 0 003.3 3.3M9.9 5.2A10.4 10.4 0 0112 5c5 0 9.3 3.1 11 7.5a11.6 11.6 0 01-4.2 5.1M6.1 6.1A11.5 11.5 0 001 12.5C2.7 16.9 7 20 12 20c1.6 0 3.1-.3 4.5-.9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M1 12.5C2.7 8.1 7 5 12 5s9.3 3.1 11 7.5c-1.7 4.4-6 7.5-11 7.5S2.7 16.9 1 12.5z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="12.5" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function Spinner() {
  return <span className="auth-spinner" aria-hidden="true" />
}

function clientPasswordError(password: string): string | null {
  if (password.length < 8) {
    return 'Password must be at least 8 characters.'
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Use letters and at least one number.'
  }
  return null
}

export function AuthShell({ initial, onAuthenticated }: AuthShellProps) {
  const [screen, setScreen] = useState<AuthScreen>(() =>
    initial.status === 'pending_verification' ? 'verify' : 'login'
  )
  const [email, setEmail] = useState(
    initial.status === 'pending_verification' ? initial.email : ''
  )
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [code, setCode] = useState(['', '', '', '', '', ''])
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(
    initial.status === 'backend_unavailable' || initial.status === 'blocked'
      ? initial.reason
      : initial.status === 'unauthenticated'
        ? initial.reason ?? ''
        : ''
  )
  const [notice, setNotice] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [resendIn, setResendIn] = useState(0)
  const [backendDown, setBackendDown] = useState(initial.status === 'backend_unavailable')
  const [blocked, setBlocked] = useState(initial.status === 'blocked' ? initial.reason : '')
  const codeRefs = useRef<Array<HTMLInputElement | null>>([])
  const submitting = useRef(false)

  useEffect(() => {
    if (resendIn <= 0) {
      return
    }
    const timer = window.setTimeout(() => setResendIn((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [resendIn])

  function applyState(state: AuthSessionState): void {
    if (state.status === 'authenticated') {
      onAuthenticated(state)
      return
    }
    if (state.status === 'pending_verification') {
      setEmail(state.email)
      setScreen('verify')
      setNotice(state.reason ?? 'Enter the 6-digit code sent to your email.')
      setResendIn(60)
      setError('')
      return
    }
    if (state.status === 'backend_unavailable') {
      setBackendDown(true)
      setError(state.reason)
      return
    }
    if (state.status === 'blocked') {
      setBlocked(state.reason)
      return
    }
    if (state.status === 'loading') {
      return
    }
    setScreen('login')
    setError(state.reason ?? '')
  }

  async function runAuth<T>(action: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<T | null> {
    if (submitting.current) {
      return null
    }
    submitting.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await action()
      if (!result.ok) {
        setError(result.error)
        return null
      }
      return result.data
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  async function onLogin(event: FormEvent): Promise<void> {
    event.preventDefault()
    const next: FieldErrors = {}
    if (!email.trim()) {
      next.email = 'Email is required.'
    }
    if (!password) {
      next.password = 'Password is required.'
    }
    setFieldErrors(next)
    if (Object.keys(next).length) {
      return
    }
    const state = await runAuth(() => window.kern.auth.login({ email: email.trim(), password }))
    if (state) {
      applyState(state)
    }
  }

  async function onRegister(event: FormEvent): Promise<void> {
    event.preventDefault()
    const next: FieldErrors = {}
    if (!fullName.trim()) {
      next.fullName = 'Full name is required.'
    }
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      next.email = 'Enter a valid email address.'
    }
    const passwordIssue = clientPasswordError(password)
    if (passwordIssue) {
      next.password = passwordIssue
    }
    if (password !== confirmPassword) {
      next.confirmPassword = 'Passwords do not match.'
    }
    setFieldErrors(next)
    if (Object.keys(next).length) {
      return
    }
    const state = await runAuth(() =>
      window.kern.auth.register({
        fullName: fullName.trim(),
        email: email.trim(),
        password,
        confirmPassword
      })
    )
    if (state) {
      applyState(state)
    }
  }

  async function onVerify(event: FormEvent): Promise<void> {
    event.preventDefault()
    const joined = code.join('')
    if (!/^\d{6}$/.test(joined)) {
      setError('Enter the 6-digit verification code.')
      return
    }
    const state = await runAuth(() => window.kern.auth.verify({ email: email.trim(), code: joined }))
    if (state) {
      applyState(state)
    }
  }

  async function onForgot(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!email.trim()) {
      setFieldErrors({ email: 'Email is required.' })
      return
    }
    const result = await runAuth(() => window.kern.auth.forgot({ email: email.trim() }))
    if (result) {
      setNotice('If an account exists for that email, a reset code was sent.')
      setScreen('reset')
      setResendIn(60)
    }
  }

  async function onReset(event: FormEvent): Promise<void> {
    event.preventDefault()
    const joined = code.join('')
    const next: FieldErrors = {}
    if (!/^\d{6}$/.test(joined)) {
      next.code = 'Enter the 6-digit reset code.'
    }
    const passwordIssue = clientPasswordError(password)
    if (passwordIssue) {
      next.password = passwordIssue
    }
    if (password !== confirmPassword) {
      next.confirmPassword = 'Passwords do not match.'
    }
    setFieldErrors(next)
    if (Object.keys(next).length) {
      return
    }
    const result = await runAuth(() =>
      window.kern.auth.reset({
        email: email.trim(),
        code: joined,
        password,
        confirmPassword
      })
    )
    if (result) {
      setPassword('')
      setConfirmPassword('')
      setCode(['', '', '', '', '', ''])
      setNotice('Password updated. You can log in with your new password.')
      setScreen('login')
    }
  }

  async function onResend(): Promise<void> {
    if (resendIn > 0 || busy) {
      return
    }
    const result = await runAuth(() => window.kern.auth.resend({ email: email.trim() }))
    if (result) {
      setNotice('A new verification code was sent.')
      setResendIn(60)
    }
  }

  async function onRetry(): Promise<void> {
    const state = await runAuth(() => window.kern.auth.retry())
    if (!state) {
      return
    }
    setBackendDown(false)
    setBlocked('')
    applyState(state)
  }

  function updateCode(index: number, value: string): void {
    const digits = value.replace(/\D/g, '')
    if (digits.length > 1) {
      const next = [...code]
      const chars = digits.slice(0, 6).split('')
      for (let i = 0; i < chars.length; i += 1) {
        next[i] = chars[i]!
      }
      setCode(next)
      const focusAt = Math.min(chars.length, 5)
      codeRefs.current[focusAt]?.focus()
      return
    }
    const next = [...code]
    next[index] = digits.slice(-1)
    setCode(next)
    if (digits && index < 5) {
      codeRefs.current[index + 1]?.focus()
    }
  }

  function onCodeKeyDown(index: number, key: string): void {
    if (key === 'Backspace' && !code[index] && index > 0) {
      codeRefs.current[index - 1]?.focus()
    }
  }

  if (blocked) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <Brand />
          <h1>Secure storage unavailable</h1>
          <p className="auth-copy">{blocked}</p>
        </div>
      </div>
    )
  }

  if (backendDown) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <Brand />
          <h1>Account service unavailable</h1>
          <p className="auth-copy">{error || 'Connect to the internet to sign in or create an account.'}</p>
          <button type="button" className="auth-primary" disabled={busy} onClick={() => void onRetry()}>
            {busy ? (
              <>
                Retrying <Spinner />
              </>
            ) : (
              'Retry connection'
            )}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Brand />
        {screen === 'login' ? (
          <form className="auth-form" onSubmit={(event) => void onLogin(event)}>
            <h1>Log in to your account</h1>
            <label className="auth-field">
              <span>Email address</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                placeholder="you@company.com"
                onChange={(event) => setEmail(event.target.value)}
              />
              {fieldErrors.email ? <em>{fieldErrors.email}</em> : null}
            </label>
            <label className="auth-field">
              <span>Password</span>
              <div className="auth-password">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  placeholder="••••••••"
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button type="button" className="auth-eye" onClick={() => setShowPassword((value) => !value)} aria-label="Toggle password">
                  <EyeIcon open={showPassword} />
                </button>
              </div>
              {fieldErrors.password ? <em>{fieldErrors.password}</em> : null}
            </label>
            <button type="button" className="auth-link auth-forgot" onClick={() => { setScreen('forgot'); setError(''); setNotice('') }}>
              Forgot Password?
            </button>
            {error ? <p className="auth-error">{error}</p> : null}
            {notice ? <p className="auth-notice">{notice}</p> : null}
            <button type="submit" className="auth-primary" disabled={busy}>
              {busy ? (
                <>
                  Thinking… <Spinner />
                </>
              ) : (
                'Log In'
              )}
            </button>
            <p className="auth-switch">
              Don&apos;t have an account?{' '}
              <button type="button" className="auth-link" onClick={() => { setScreen('register'); setError(''); setNotice('') }}>
                Register
              </button>
            </p>
          </form>
        ) : null}

        {screen === 'register' ? (
          <form className="auth-form" onSubmit={(event) => void onRegister(event)}>
            <h1>Create your account</h1>
            <label className="auth-field">
              <span>Full Name</span>
              <input
                type="text"
                autoComplete="name"
                value={fullName}
                placeholder="Alex Rivera"
                onChange={(event) => setFullName(event.target.value)}
              />
              {fieldErrors.fullName ? <em>{fieldErrors.fullName}</em> : null}
            </label>
            <label className="auth-field">
              <span>Email address</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                placeholder="you@company.com"
                onChange={(event) => setEmail(event.target.value)}
              />
              {fieldErrors.email ? <em>{fieldErrors.email}</em> : null}
            </label>
            <label className="auth-field">
              <span>Password</span>
              <div className="auth-password">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  placeholder="At least 8 characters"
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button type="button" className="auth-eye" onClick={() => setShowPassword((value) => !value)} aria-label="Toggle password">
                  <EyeIcon open={showPassword} />
                </button>
              </div>
              {fieldErrors.password ? <em>{fieldErrors.password}</em> : null}
            </label>
            <label className="auth-field">
              <span>Confirm Password</span>
              <div className="auth-password">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassword}
                  placeholder="Repeat password"
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
                <button type="button" className="auth-eye" onClick={() => setShowConfirm((value) => !value)} aria-label="Toggle confirm password">
                  <EyeIcon open={showConfirm} />
                </button>
              </div>
              {fieldErrors.confirmPassword ? <em>{fieldErrors.confirmPassword}</em> : null}
            </label>
            {error ? <p className="auth-error">{error}</p> : null}
            <button type="submit" className="auth-primary" disabled={busy}>
              {busy ? (
                <>
                  Create Account <Spinner />
                </>
              ) : (
                'Create Account'
              )}
            </button>
            <p className="auth-switch">
              Already have an account?{' '}
              <button type="button" className="auth-link" onClick={() => { setScreen('login'); setError(''); setNotice('') }}>
                Log In
              </button>
            </p>
          </form>
        ) : null}

        {screen === 'verify' ? (
          <form className="auth-form" onSubmit={(event) => void onVerify(event)}>
            <h1>Verify your email</h1>
            <p className="auth-copy">Enter the 6-digit code sent to <strong>{email}</strong>.</p>
            <div className="auth-otp" onPaste={(event) => {
              const text = event.clipboardData.getData('text')
              if (/\d{6}/.test(text)) {
                event.preventDefault()
                updateCode(0, text)
              }
            }}>
              {code.map((digit, index) => (
                <input
                  key={index}
                  ref={(node) => {
                    codeRefs.current[index] = node
                  }}
                  className="auth-otp-cell"
                  inputMode="numeric"
                  maxLength={6}
                  value={digit}
                  onChange={(event) => updateCode(index, event.target.value)}
                  onKeyDown={(event) => onCodeKeyDown(index, event.key)}
                  aria-label={`Digit ${index + 1}`}
                />
              ))}
            </div>
            {error ? <p className="auth-error">{error}</p> : null}
            {notice ? <p className="auth-notice">{notice}</p> : null}
            <button type="submit" className="auth-primary" disabled={busy}>
              {busy ? (
                <>
                  Verifying <Spinner />
                </>
              ) : (
                'Verify email'
              )}
            </button>
            <button type="button" className="auth-secondary" disabled={busy || resendIn > 0} onClick={() => void onResend()}>
              {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
            </button>
            <p className="auth-switch">
              Wrong email?{' '}
              <button
                type="button"
                className="auth-link"
                onClick={() => {
                  setScreen('register')
                  setCode(['', '', '', '', '', ''])
                  setError('')
                  setNotice('')
                }}
              >
                Change email
              </button>
            </p>
          </form>
        ) : null}

        {screen === 'forgot' ? (
          <form className="auth-form" onSubmit={(event) => void onForgot(event)}>
            <h1>Reset your password</h1>
            <p className="auth-copy">We will email a reset code if an account exists for that address.</p>
            <label className="auth-field">
              <span>Email address</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                placeholder="you@company.com"
                onChange={(event) => setEmail(event.target.value)}
              />
              {fieldErrors.email ? <em>{fieldErrors.email}</em> : null}
            </label>
            {error ? <p className="auth-error">{error}</p> : null}
            {notice ? <p className="auth-notice">{notice}</p> : null}
            <button type="submit" className="auth-primary" disabled={busy}>
              {busy ? (
                <>
                  Sending <Spinner />
                </>
              ) : (
                'Send reset code'
              )}
            </button>
            <p className="auth-switch">
              <button type="button" className="auth-link" onClick={() => setScreen('login')}>
                Back to log in
              </button>
            </p>
          </form>
        ) : null}

        {screen === 'reset' ? (
          <form className="auth-form" onSubmit={(event) => void onReset(event)}>
            <h1>Choose a new password</h1>
            <p className="auth-copy">Enter the code sent to <strong>{email}</strong>.</p>
            <div className="auth-otp">
              {code.map((digit, index) => (
                <input
                  key={index}
                  ref={(node) => {
                    codeRefs.current[index] = node
                  }}
                  className="auth-otp-cell"
                  inputMode="numeric"
                  maxLength={6}
                  value={digit}
                  onChange={(event) => updateCode(index, event.target.value)}
                  onKeyDown={(event) => onCodeKeyDown(index, event.key)}
                  aria-label={`Digit ${index + 1}`}
                />
              ))}
            </div>
            {fieldErrors.code ? <em className="auth-inline-error">{fieldErrors.code}</em> : null}
            <label className="auth-field">
              <span>New password</span>
              <div className="auth-password">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button type="button" className="auth-eye" onClick={() => setShowPassword((value) => !value)} aria-label="Toggle password">
                  <EyeIcon open={showPassword} />
                </button>
              </div>
              {fieldErrors.password ? <em>{fieldErrors.password}</em> : null}
            </label>
            <label className="auth-field">
              <span>Confirm password</span>
              <div className="auth-password">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
                <button type="button" className="auth-eye" onClick={() => setShowConfirm((value) => !value)} aria-label="Toggle confirm password">
                  <EyeIcon open={showConfirm} />
                </button>
              </div>
              {fieldErrors.confirmPassword ? <em>{fieldErrors.confirmPassword}</em> : null}
            </label>
            {error ? <p className="auth-error">{error}</p> : null}
            <button type="submit" className="auth-primary" disabled={busy}>
              {busy ? (
                <>
                  Updating <Spinner />
                </>
              ) : (
                'Update password'
              )}
            </button>
            <p className="auth-switch">
              <button type="button" className="auth-link" onClick={() => setScreen('login')}>
                Back to log in
              </button>
            </p>
          </form>
        ) : null}
      </div>
    </div>
  )
}

function Brand() {
  return (
    <div className="auth-brand">
      <img src={kernLogo} alt="" width={48} height={48} className="auth-logo" />
      <div>
        <div className="auth-wordmark">KERN</div>
        <div className="auth-tagline">From Intention to Verified Code.</div>
      </div>
    </div>
  )
}
