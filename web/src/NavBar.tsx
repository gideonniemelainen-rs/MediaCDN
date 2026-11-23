import { ROUTES, type RouteId } from './routes'

/** Full-width top bar: brand on the left, page links on the right. */
export default function NavBar({ current }: { current: RouteId }) {
  return (
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
    </header>
  )
}
