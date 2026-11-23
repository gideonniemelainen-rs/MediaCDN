import type { ReactNode } from 'react'
import NavBar from '../NavBar'
import type { RouteId } from '../routes'
import { LoginForm } from './LoginForm'
import { refreshAuth } from './store'
import { useAuth } from './useAuth'

/** Renders its children only for a signed-in user; otherwise the login form, or why there is none. */
export function RequireAuth({ current, children }: { current: RouteId; children: ReactNode }) {
  const auth = useAuth()
  if (auth.status === 'signedIn') return <>{children}</>
  return (
    <div className="app">
      <NavBar current={current} />
      <main className="auth-page">
      {auth.status === 'checking' && <p className="auth-note">Checking your session…</p>}
      {auth.status === 'signedOut' && <LoginForm />}
      {auth.status === 'unreachable' && (
        <div className="auth-card">
          <h1>Pipeline server not reachable</h1>
          <p>Start it with <code>node pipeline/bin/serve.mjs</code> (it needs the database: <code>docker compose -f pipeline/compose.yaml up -d db</code>).</p>
          <button type="button" onClick={() => void refreshAuth()}>Try again</button>
        </div>
      )}
      </main>
    </div>
  )
}
