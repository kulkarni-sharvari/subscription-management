import { useEffect, useState } from 'react'
import { api, toFormError } from '../api/client'
import type { User } from '../auth/auth-context'
import { AppShell } from '../components/AppShell'

// The user's own settings. Story 10: the monthly summary email can be turned off and on here (the
// email's unsubscribe link only turns it off).
export default function Settings() {
  const [monthlySummary, setMonthlySummary] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<User>('/me')
      .then((me) => !cancelled && setMonthlySummary(me.monthlySummary))
      .catch((err: unknown) => !cancelled && setMessage({ kind: 'error', text: toFormError(err).message }))
    return () => {
      cancelled = true
    }
  }, [])

  async function change(next: boolean) {
    setSaving(true)
    setMessage(null)
    try {
      const me = await api.patch<User>('/me', { monthlySummary: next })
      setMonthlySummary(me.monthlySummary)
      setMessage({ kind: 'saved', text: me.monthlySummary ? 'You will get the monthly summary.' : 'You will no longer get the monthly summary.' })
    } catch (err) {
      setMessage({ kind: 'error', text: toFormError(err).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppShell>
      <h1 className="heading">Settings</h1>
      <section className="card stack" aria-label="Email">
        <h2 className="font-medium">Email</h2>
        {monthlySummary === null && !message && <p className="muted">Loading…</p>}
        {monthlySummary !== null && (
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1" checked={monthlySummary} disabled={saving} onChange={(e) => void change(e.target.checked)} />
            <span>
              Monthly summary
              <span className="muted block">On the 1st of each month: what you paid last month, your monthly cost and anything that needs action.</span>
            </span>
          </label>
        )}
        {message && (
          <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'alert-error' : 'muted'}>
            {message.text}
          </p>
        )}
      </section>
    </AppShell>
  )
}
