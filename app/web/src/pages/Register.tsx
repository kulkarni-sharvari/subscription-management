import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { toFormError } from '../api/client'
import { useAuth } from '../auth/auth-context'
import { AuthLayout } from '../components/AuthLayout'
import { FormField } from '../components/FormField'

// Mirrors the server rule so the user gets instant feedback; the server still enforces it.
const MIN_PASSWORD_LENGTH = 14

export default function Register() {
  const { register } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [doneMessage, setDoneMessage] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, field: 'password' })
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      setDoneMessage(await register(email, password))
    } catch (err) {
      setError(toFormError(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (doneMessage) {
    return (
      <AuthLayout title="Check your email" footer={<Link to="/login" className="link">Back to sign in</Link>}>
        <p className="alert-success">{doneMessage}</p>
        <p className="muted">Open the link in the email to finish creating your account. It can take a few minutes to arrive.</p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Create your account"
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="link">
            Sign in
          </Link>
        </>
      }
    >
      <form className="stack" onSubmit={handleSubmit} noValidate>
        <FormField
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error?.field === 'email' ? error.message : undefined}
        />
        <FormField
          label="Password"
          type="password"
          name="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters`}
          error={error?.field === 'password' ? error.message : undefined}
        />
        {error && !error.field && (
          <p role="alert" className="alert-error">
            {error.message}
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  )
}
