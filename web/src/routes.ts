// There is no router: each page is a pathname. Links are plain anchors, so every navigation is a full page load.
export type RouteId = 'player' | 'upload' | 'analysis'

export const ROUTES: { id: RouteId; path: string; label: string }[] = [
  { id: 'player', path: '/', label: 'Player' },
  { id: 'upload', path: '/upload/', label: 'Upload' },
  { id: 'analysis', path: '/analysis/', label: 'Analysis' },
]

/** The page for a pathname; anything unrecognised is the player. A trailing slash is optional. */
export function routeFor(pathname: string): RouteId {
  const clean = pathname.replace(/\/+$/, '')
  return ROUTES.find((r) => r.path !== '/' && r.path.replace(/\/$/, '') === clean)?.id ?? 'player'
}
