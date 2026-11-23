import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAuth, refreshAuth, resetAuth, sessionEnded, signIn, signOut, updatePassword } from './store'

const USER = { id: 'u1', username: 'admin', role: 'admin', mustChangePassword: true }
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

afterEach(() => {
  vi.unstubAllGlobals()
  resetAuth()
})

describe('auth store', () => {
  it('starts out checking, then signed in when the server knows the cookie', async () => {
    expect(getAuth()).toEqual({ status: 'checking' })
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { user: USER })))
    await refreshAuth()
    expect(getAuth()).toEqual({ status: 'signedIn', user: USER })
  })

  it('is signed out on a 401 and unreachable when the server cannot be reached or errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'sign in required' })))
    await refreshAuth()
    expect(getAuth().status).toBe('signedOut')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await refreshAuth()
    expect(getAuth().status).toBe('unreachable')
    vi.stubGlobal('fetch', vi.fn(async () => reply(502, {})))
    await refreshAuth()
    expect(getAuth().status).toBe('unreachable')
  })

  it('signs in with the credentials as JSON, and rejects with the server message', async () => {
    const fetchFn = vi.fn(async () => reply(200, { user: USER }))
    vi.stubGlobal('fetch', fetchFn)
    await signIn('admin', 'admin')
    expect(fetchFn).toHaveBeenCalledWith('/api/pipeline/auth/login', expect.objectContaining({ method: 'POST', body: '{"username":"admin","password":"admin"}' }))
    expect(getAuth().status).toBe('signedIn')
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'wrong username or password' })))
    await expect(signIn('admin', 'x')).rejects.toThrow('wrong username or password')
  })

  it('signs out even if the request fails, and treats a 401 elsewhere as the session ending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { user: USER })))
    await signIn('admin', 'admin')
    sessionEnded()
    expect(getAuth().status).toBe('signedOut')
    await signIn('admin', 'admin')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down') }))
    await signOut()
    expect(getAuth().status).toBe('signedOut')
  })

  it('takes the updated user, with the change flag cleared, from a password change', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { user: { ...USER, mustChangePassword: false } })))
    await updatePassword('admin', 'a long password')
    expect(getAuth()).toEqual({ status: 'signedIn', user: { ...USER, mustChangePassword: false } })
  })
})
