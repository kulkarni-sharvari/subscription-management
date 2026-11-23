import { useEffect, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { toFormError } from '../api/client'
import {
  formatMoney,
  listSubscriptions,
  PAYMENT_METHOD_LABEL,
  PERIOD_LABEL,
  STATUSES,
  type Subscription,
  type SubscriptionStatus,
} from '../api/subscriptions'
import { AppShell } from '../components/AppShell'

const TAB_LABEL: Record<SubscriptionStatus, string> = {
  active: 'Active',
  'active-unknown': 'Needs action',
  inactive: 'Inactive',
}

const EMPTY_TEXT: Record<SubscriptionStatus, string> = {
  active: 'No active subscriptions yet. Add your first subscription or one-time purchase to start tracking it.',
  'active-unknown': 'Nothing needs your attention. A subscription appears here when its renewal date passes and you have not confirmed what happened.',
  inactive: 'No inactive subscriptions. Cancelled subscriptions are kept here.',
}

// The date line of a row. For a subscription that is not active it is the last date a payment was due.
function dateLine(sub: Subscription): string {
  const date = sub.currentCycle?.dueDate ?? '—'
  if (sub.status === 'active-unknown') return `Renewal missed ${date}`
  if (sub.status === 'inactive') return `Last due ${date}`
  return `${sub.billingPeriod ? 'Renews' : 'Due'} ${date}`
}

type ListState =
  | { kind: 'loading'; status: SubscriptionStatus }
  | { kind: 'error'; status: SubscriptionStatus; message: string }
  | { kind: 'ready'; status: SubscriptionStatus; items: Subscription[]; nextCursor: string | null }

// The signed-in home: the user's subscriptions in three views (Story 3). The API sorts them and
// returns them a page at a time.
export default function Home() {
  const [params] = useSearchParams()
  // The address bar is user-editable input: only the three known values are accepted.
  const requested = params.get('status')
  const status = STATUSES.find((s) => s === requested) ?? 'active'

  const [state, setState] = useState<ListState>({ kind: 'loading', status })
  const [attempt, setAttempt] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)

  // The add form sends the name of what it just saved; show it once as text.
  const location = useLocation()
  const added = (location.state as { added?: unknown } | null)?.added
  const addedName = typeof added === 'string' ? added : null

  useEffect(() => {
    let cancelled = false
    listSubscriptions(status)
      .then((page) => {
        if (!cancelled) setState({ kind: 'ready', status, items: page.items, nextCursor: page.nextCursor })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', status, message: toFormError(err).message })
      })
    return () => {
      cancelled = true
    }
  }, [status, attempt])

  // What was loaded for another tab is not shown while this tab loads.
  const current: ListState = state.status === status ? state : { kind: 'loading', status }

  function retry() {
    setState({ kind: 'loading', status })
    setAttempt((n) => n + 1)
  }

  async function loadMore() {
    if (current.kind !== 'ready' || !current.nextCursor) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await listSubscriptions(status, current.nextCursor)
      // Ignore the answer if the user has moved to another tab in the meantime.
      setState((prev) =>
        prev.kind === 'ready' && prev.status === status
          ? { ...prev, items: [...prev.items, ...page.items], nextCursor: page.nextCursor }
          : prev,
      )
    } catch (err) {
      setMoreError(toFormError(err).message)
    } finally {
      setLoadingMore(false)
    }
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

      <nav className="tabs" aria-label="Subscription views">
        {STATUSES.map((s) => (
          <Link
            key={s}
            to={s === 'active' ? '/' : `/?status=${s}`}
            className={s === status ? 'tab-active' : 'tab'}
            aria-current={s === status ? 'page' : undefined}
          >
            {TAB_LABEL[s]}
          </Link>
        ))}
      </nav>

      {current.kind === 'loading' && <p className="muted">Loading…</p>}

      {current.kind === 'error' && (
        <div className="stack">
          <p role="alert" className="alert-error">
            {current.message}
          </p>
          <div>
            <button type="button" className="btn-secondary" onClick={retry}>
              Try again
            </button>
          </div>
        </div>
      )}

      {current.kind === 'ready' && current.items.length === 0 && (
        <div className="empty-state stack">
          <p className="muted">{EMPTY_TEXT[status]}</p>
          {status === 'active' && (
            <div>
              <Link to="/subscriptions/new" className="btn-primary">
                Add subscription
              </Link>
            </div>
          )}
        </div>
      )}

      {current.kind === 'ready' && current.items.length > 0 && (
        <>
          {status === 'active-unknown' && (
            <p className="alert-warning">
              These renewal dates passed and nothing was recorded. Open one and record whether it renewed or you cancelled it, so its dates and costs stay accurate.
            </p>
          )}
          <ul className="sub-list">
            {current.items.map((sub) => (
              <li key={sub.id} className={sub.status === 'active-unknown' ? 'sub-row sub-row-attention' : 'sub-row'}>
                <div>
                  {/* React shows text as text, so a name such as <img onerror=…> stays inert (SEC-036). */}
                  <Link to={`/subscriptions/${sub.id}`} className="link">
                    {sub.name}
                  </Link>
                  <p className="muted">{sub.category}</p>
                </div>
                <div>
                  <p className="font-medium">{formatMoney(sub.cost)}</p>
                  <p className="muted">{sub.billingPeriod ? PERIOD_LABEL[sub.billingPeriod] : 'One-time purchase'}</p>
                </div>
                <div>
                  <p>{dateLine(sub)}</p>
                  <p className="muted">{PAYMENT_METHOD_LABEL[sub.paymentMethod.type]}</p>
                </div>
                {sub.status === 'active-unknown' ? (
                  <span className="badge-warning">Needs action</span>
                ) : (
                  sub.autoRenews && <span className="badge">Auto-renews</span>
                )}
              </li>
            ))}
          </ul>

          {moreError && (
            <p role="alert" className="alert-error">
              {moreError}
            </p>
          )}
          {current.nextCursor && (
            <div>
              <button type="button" className="btn-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </AppShell>
  )
}
