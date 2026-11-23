// Client for the pipeline server's /auth routes. The session is an HttpOnly cookie, so nothing here
// handles the token; same-origin fetch sends it.
const BASE = '/api/pipeline/auth'

export interface User {
  id: string
  username: string
  role: 'admin' | 'user'
  mustChangePassword: boolean
}

export class AuthError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      cache: 'no-store',
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    })
  } catch {
    throw new AuthError('could not reach the pipeline server', 0)
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new AuthError(body.error ?? `request failed (${res.status})`, res.status)
  return body as T
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const fetchMe = () => call<{ user: User }>('/me').then((r) => r.user)
export const login = (username: string, password: string) => post<{ user: User }>('/login', { username, password }).then((r) => r.user)
export const logout = () => post('/logout')
export const changePassword = (current: string, next: string) =>
  post<{ user: User }>('/password', { current, next }).then((r) => r.user)
