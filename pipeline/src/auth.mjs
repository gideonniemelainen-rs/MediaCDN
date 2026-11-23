// Password hashing, session tokens, the session cookie and the login rate limit. No dependencies.
import { randomBytes, scrypt, createHash, timingSafeEqual } from 'node:crypto'

export const COOKIE = 'sid'
export const SESSION_DAYS = 7
export const MIN_PASSWORD = 8

const N = 16384, R = 8, P = 1, KEYLEN = 32
const derive = (password, salt, n = N, r = R, p = P) =>
  new Promise((resolve, reject) => scrypt(password, salt, KEYLEN, { N: n, r, p }, (e, key) => (e ? reject(e) : resolve(key))))

/** `scrypt$N$r$p$<salt b64>$<hash b64>`: the parameters travel with the hash so they can change later. */
export async function hashPassword(password) {
  const salt = randomBytes(16)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${(await derive(password, salt)).toString('base64')}`
}

export async function verifyPassword(password, stored) {
  const [scheme, n, r, p, salt, hash] = String(stored).split('$')
  if (scheme !== 'scrypt' || !hash) return false
  const want = Buffer.from(hash, 'base64')
  const got = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p))
  return want.length === got.length && timingSafeEqual(want, got)
}

export const newToken = () => randomBytes(32).toString('base64url')
export const hashToken = (token) => createHash('sha256').update(token).digest('hex')

export function parseCookies(header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

export const sessionCookie = (token) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`

/** The session token from a request: Bearer header first, then the cookie. */
export function tokenFrom(headers) {
  const m = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')
  return m ? m[1] : parseCookies(headers.cookie)[COOKIE]
}

/** Fixed-window limiter: `limit` failures per `windowMs` per key. In memory, so it resets on restart. */
export function createRateLimiter({ limit = 5, windowMs = 60_000, now = Date.now } = {}) {
  const hits = new Map()
  const live = (key) => {
    const e = hits.get(key)
    if (e && now() - e.start < windowMs) return e
    hits.delete(key)
    return undefined
  }
  return {
    blocked: (key) => (live(key)?.count ?? 0) >= limit,
    fail(key) {
      const e = live(key) ?? { start: now(), count: 0 }
      e.count++
      hits.set(key, e)
    },
    reset: (key) => hits.delete(key),
  }
}
