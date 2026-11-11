import { Navigate, Outlet } from 'react-router'
import { useAuth } from './auth-context'

// Wraps the routes that need a signed-in user. This is a convenience for the screen only:
// the API still checks the session on every request, so it is not what protects the data.
export function RequireAuth() {
  const { status } = useAuth()
  if (status === 'loading') return <p className="page-center muted">Loading…</p>
  if (status === 'anonymous') return <Navigate to="/login" replace />
  return <Outlet />
}

// Wraps login and register: someone who is already signed in has no reason to see them.
export function PublicOnly() {
  const { status } = useAuth()
  if (status === 'loading') return <p className="page-center muted">Loading…</p>
  if (status === 'authenticated') return <Navigate to="/" replace />
  return <Outlet />
}
