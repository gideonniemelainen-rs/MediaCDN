import { PasswordBanner } from './auth/PasswordBanner'
import { signOut } from './auth/store'
import { useAuth } from './auth/useAuth'
import { ROUTES, type RouteId } from './routes'

/** Full-width top bar: brand on the left, page links and the signed-in user on the right. */
export default function NavBar({ current }: { current: RouteId }) {
  const auth = useAuth()
  const user = auth.status === 'signedIn' ? auth.user : null
  return (
    <>
      <header className="topnav">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true" />
          Media CDN Lab
        </a>
        <nav aria-label="Pages">
          {ROUTES.map((r) => (
            <a key={r.id} href={r.path} className={r.id === current ? 'active' : undefined} aria-current={r.id === current ? 'page' : undefined}>
              {r.label}
            </a>
          ))}
        </nav>
        {auth.status === 'signedOut' && (
          <div className="whoami">
            <a href="/analysis/">Sign in</a>
          </div>
        )}
        {user && (
          <div className="whoami">
            <span>{user.username}</span>
            <button type="button" onClick={() => void signOut()}>Sign out</button>
          </div>
        )}
      </header>
      {user?.mustChangePassword && <PasswordBanner />}
    </>
  )
}
