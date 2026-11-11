import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toFormError } from '../api/client'
import { useAuth } from '../auth/auth-context'
import { AuthLayout } from '../components/AuthLayout'

// The page the confirmation email links to: /auth/confirm?token_hash=...&type=email
export default function ConfirmEmail() {
  const { confirmEmail } = useAuth()
  const navigate = useNavigate()
  // Read once; the address bar is cleaned below so the one-time token does not stay in history.
  const [tokenHash] = useState(() => {
    const query = new URLSearchParams(window.location.search)
    return query.get('type') === 'email' ? query.get('token_hash') : null
  })
  const started = useRef(false)
  const [error, setError] = useState<string | null>(tokenHash ? null : 'This confirmation link is invalid.')

  useEffect(() => {
    // The link can be used once. React runs effects twice in development, so only start once.
    if (started.current || !tokenHash) return
    started.current = true
    window.history.replaceState(null, '', window.location.pathname)
    confirmEmail(tokenHash)
      .then(() => navigate('/', { replace: true }))
      .catch((err) => setError(toFormError(err).message))
  }, [confirmEmail, navigate, tokenHash])

  return (
    <AuthLayout title="Confirming your email">
      {error ? (
        <>
          <p role="alert" className="alert-error">
            {error}
          </p>
          <Link to="/login" className="link">
            Go to sign in
          </Link>
        </>
      ) : (
        <p className="muted">One moment…</p>
      )}
    </AuthLayout>
  )
}
