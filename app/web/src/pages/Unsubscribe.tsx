import { useState } from 'react'
import { Link } from 'react-router'
import { api, toFormError } from '../api/client'
import { AuthLayout } from '../components/AuthLayout'

// The page the monthly summary's "Unsubscribe" link opens: /unsubscribe?u=<user id>&t=<signature>.
// It works without signing in. Opening it changes nothing (mail scanners open links); only the
// button does, by POSTing the signed link to the API, which checks the signature (Story 10).
export default function Unsubscribe() {
  // Read once; the address bar is cleaned so the signed link does not stay in the history.
  const [link] = useState(() => {
    const query = new URLSearchParams(window.location.search)
    const u = query.get('u')
    const t = query.get('t')
    window.history.replaceState(null, '', window.location.pathname)
    return u && t ? new URLSearchParams({ u, t }).toString() : null
  })
  const [state, setState] = useState<'ready' | 'sending' | 'done'>('ready')
  const [error, setError] = useState<string | null>(link ? null : 'This unsubscribe link is not valid.')

  async function unsubscribe() {
    setState('sending')
    setError(null)
    try {
      await api.post(`/email/unsubscribe?${link}`)
      setState('done')
    } catch (err) {
      setError(toFormError(err).message)
      setState('ready')
    }
  }

  return (
    <AuthLayout title="Monthly summary email">
      {state === 'done' ? (
        <p role="status">You will no longer get the monthly summary. You can turn it back on in Settings.</p>
      ) : (
        <>
          {error && (
            <p role="alert" className="alert-error">
              {error}
            </p>
          )}
          {link && (
            <>
              <p className="muted">Stop the summary email sent on the 1st of each month? Other emails, such as renewal reminders, are not affected.</p>
              <button type="button" className="btn-primary" disabled={state === 'sending'} onClick={() => void unsubscribe()}>
                Unsubscribe
              </button>
            </>
          )}
        </>
      )}
      <Link to="/" className="link">
        Go to the app
      </Link>
    </AuthLayout>
  )
}
