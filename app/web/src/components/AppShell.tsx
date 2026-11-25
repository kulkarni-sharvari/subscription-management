import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/auth-context'

// The frame around every signed-in screen: the header with the account and sign-out, then the page.
export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  return (
    <>
      <header className="app-header">
        <nav className="flex items-center gap-6" aria-label="Main">
          <Link to="/" className="font-semibold">
            Subscription Manager
          </Link>
          <Link to="/analytics" className="link">
            Spending
          </Link>
        </nav>
        <div className="flex items-center gap-4">
          <span className="muted">{user?.email}</span>
          <button type="button" className="btn-secondary" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="app-main stack">{children}</main>
    </>
  )
}
