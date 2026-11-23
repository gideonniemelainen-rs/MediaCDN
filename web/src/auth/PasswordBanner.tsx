import { useState, type FormEvent } from 'react'
import { updatePassword } from './store'

/** Shown while the account still has its seeded password. */
export function PasswordBanner() {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await updatePassword(current, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not change the password')
    }
  }

  return (
    <div className="pw-banner" role="status">
      <span>This account still has its default password.</span>
      {!open && <button type="button" onClick={() => setOpen(true)}>Change it</button>}
      {open && (
        <form onSubmit={submit}>
          <input type="password" placeholder="Current" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          <input type="password" placeholder="New (8+ characters)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
          <button type="submit">Save</button>
          {error && <span className="auth-error" role="alert">{error}</span>}
        </form>
      )}
    </div>
  )
}
