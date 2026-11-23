// Who is signed in, shared by the navbar and the pages that need a session. A plain external store
// (like the catalog and telemetry stores) read with useSyncExternalStore.
import * as api from './api'
import type { User } from './api'

export type AuthState =
  | { status: 'checking' }
  | { status: 'signedOut' }
  | { status: 'unreachable' }
  | { status: 'signedIn'; user: User }

let state: AuthState = { status: 'checking' }
const listeners = new Set<() => void>()
const set = (next: AuthState) => {
  state = next
  listeners.forEach((l) => l())
}

export const getAuth = () => state
export const subscribeAuth = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** Ask the server who we are. Called once at startup and again after the server was unreachable. */
export async function refreshAuth(): Promise<void> {
  try {
    set({ status: 'signedIn', user: await api.fetchMe() })
  } catch (e) {
    set({ status: e instanceof api.AuthError && e.status === 401 ? 'signedOut' : 'unreachable' })
  }
}

export async function signIn(username: string, password: string): Promise<void> {
  set({ status: 'signedIn', user: await api.login(username, password) })
}

export async function signOut(): Promise<void> {
  await api.logout().catch(() => {})
  set({ status: 'signedOut' })
}

export async function updatePassword(current: string, next: string): Promise<void> {
  set({ status: 'signedIn', user: await api.changePassword(current, next) })
}

/** Any API call that comes back 401 means the session ended (expired, or signed out elsewhere). */
export function sessionEnded(): void {
  if (state.status === 'signedIn') set({ status: 'signedOut' })
}

/** Tests only. */
export function resetAuth(): void {
  state = { status: 'checking' }
}
