import { useAuth } from '../auth/auth-context'

// Placeholder for the signed-in area. The subscription screens arrive in later stories.
export default function Home() {
  const { user, logout } = useAuth()
  return (
    <>
      <header className="app-header">
        <span className="font-semibold">Subscription Manager</span>
        <div className="flex items-center gap-4">
          <span className="muted">{user?.email}</span>
          <button type="button" className="btn-secondary" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="app-main stack">
        <h1 className="heading">Your subscriptions</h1>
        <p className="muted">Nothing here yet. Subscriptions will appear on this page.</p>
      </main>
    </>
  )
}
