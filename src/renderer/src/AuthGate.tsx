import { useEffect, useState } from 'react'
import type { AuthPublicUser, AuthSessionState } from '../../shared/auth'
import { App } from './App'
import { AuthShell } from './components/AuthShell'

export function AuthGate() {
  const [state, setState] = useState<AuthSessionState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    void window.kern.auth.status().then((result) => {
      if (cancelled) {
        return
      }
      if (!result.ok) {
        setState({ status: 'backend_unavailable', reason: result.error, canRetry: true })
        return
      }
      setState(result.data)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (state.status === 'loading') {
    return (
      <div className="auth-shell">
        <div className="auth-card auth-card-loading">
          <div className="auth-wordmark">KERN</div>
          <p className="auth-copy">Checking your account…</p>
        </div>
      </div>
    )
  }

  if (state.status === 'authenticated') {
    return (
      <App
        authUser={state.user}
        offlineGrace={state.offlineGrace}
        onLogout={() => setState({ status: 'unauthenticated' })}
      />
    )
  }

  return (
    <AuthShell
      initial={state}
      onAuthenticated={(next) => setState(next)}
    />
  )
}

export type AppAuthProps = {
  authUser: AuthPublicUser
  offlineGrace: boolean
  onLogout: () => void
}
