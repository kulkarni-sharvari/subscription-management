import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { toFormError } from '../api/client'
import {
  formatMoney,
  listSubscriptions,
  PAYMENT_METHOD_LABEL,
  PERIOD_LABEL,
  type Subscription,
} from '../api/subscriptions'
import { AppShell } from '../components/AppShell'

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: Subscription[] }

// The signed-in home: the user's active subscriptions, soonest renewal first (the API sorts them).
export default function Home() {
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  // The add form sends the name of what it just saved; show it once as text.
  const location = useLocation()
  const added = (location.state as { added?: unknown } | null)?.added
  const addedName = typeof added === 'string' ? added : null

  useEffect(() => {
    let cancelled = false
    listSubscriptions('active')
      .then((items) => {
        if (!cancelled) setState({ kind: 'ready', items })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: toFormError(err).message })
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  function retry() {
    setState({ kind: 'loading' })
    setAttempt((n) => n + 1)
  }

  return (
    <AppShell>
      <div className="page-actions">
        <h1 className="heading">Your subscriptions</h1>
        <Link to="/subscriptions/new" className="btn-primary">
          Add subscription
        </Link>
      </div>

      {addedName && (
        <p role="status" className="alert-success">
          Added {addedName}. A confirmation email is on its way.
        </p>
      )}

      {state.kind === 'loading' && <p className="muted">Loading…</p>}

      {state.kind === 'error' && (
        <div className="stack">
          <p role="alert" className="alert-error">
            {state.message}
          </p>
          <div>
            <button type="button" className="btn-secondary" onClick={retry}>
              Try again
            </button>
          </div>
        </div>
      )}

      {state.kind === 'ready' && state.items.length === 0 && (
        <div className="empty-state stack">
          <p className="font-medium">No subscriptions yet</p>
          <p className="muted">Add your first subscription or one-time purchase to start tracking it.</p>
          <div>
            <Link to="/subscriptions/new" className="btn-primary">
              Add subscription
            </Link>
          </div>
        </div>
      )}

      {state.kind === 'ready' && state.items.length > 0 && (
        <ul className="sub-list">
          {state.items.map((sub) => (
            <li key={sub.id} className="sub-row">
              <div>
                {/* React shows text as text, so a name such as <img onerror=…> stays inert (SEC-036). */}
                <p className="font-medium">{sub.name}</p>
                <p className="muted">{sub.category}</p>
              </div>
              <div>
                <p className="font-medium">{formatMoney(sub.cost)}</p>
                <p className="muted">{sub.billingPeriod ? PERIOD_LABEL[sub.billingPeriod] : 'One-time purchase'}</p>
              </div>
              <div>
                <p>
                  {sub.billingPeriod ? 'Renews' : 'Due'} {sub.currentCycle?.dueDate ?? '—'}
                </p>
                <p className="muted">{PAYMENT_METHOD_LABEL[sub.paymentMethod.type]}</p>
              </div>
              {sub.autoRenews && <span className="badge">Auto-renews</span>}
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  )
}
