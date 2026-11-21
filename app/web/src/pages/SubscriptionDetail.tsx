import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError, toFormError } from '../api/client'
import {
  formatMoney,
  getSubscription,
  PAYMENT_METHOD_LABEL,
  PERIOD_LABEL,
  type SubscriptionDetail as Detail,
} from '../api/subscriptions'
import { AppShell } from '../components/AppShell'

const STATUS_LABEL = { active: 'Active', 'active-unknown': 'Needs action', inactive: 'Inactive' } as const

type DetailState =
  | { kind: 'loading'; id: string }
  | { kind: 'missing'; id: string }
  | { kind: 'error'; id: string; message: string }
  | { kind: 'ready'; id: string; subscription: Detail }

// A stored link is shown as a link only if it is a web address. The API already refuses any other
// kind, so this is a second check on the way out (SEC-035). noopener keeps the opened page from
// reaching back to this one; noreferrer stops it learning where the visitor came from.
function SafeLink({ href }: { href: string | null }) {
  if (!href) return <span className="muted">Not set</span>
  if (!/^https?:\/\//i.test(href)) return <span>{href}</span>
  return (
    <a href={href} className="link" target="_blank" rel="noopener noreferrer">
      {href}
    </a>
  )
}

export default function SubscriptionDetail() {
  const { id = '' } = useParams()
  const [state, setState] = useState<DetailState>({ kind: 'loading', id })

  useEffect(() => {
    let cancelled = false
    getSubscription(id)
      .then((subscription) => {
        if (!cancelled) setState({ kind: 'ready', id, subscription })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) setState({ kind: 'missing', id })
        else setState({ kind: 'error', id, message: toFormError(err).message })
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const current: DetailState = state.id === id ? state : { kind: 'loading', id }

  return (
    <AppShell>
      <div>
        <Link to="/" className="link">
          ← Back to subscriptions
        </Link>
      </div>

      {current.kind === 'loading' && <p className="muted">Loading…</p>}

      {current.kind === 'missing' && (
        <div className="empty-state stack">
          <p className="font-medium">Subscription not found</p>
          <p className="muted">It may not exist, or it may not be yours.</p>
        </div>
      )}

      {current.kind === 'error' && (
        <p role="alert" className="alert-error">
          {current.message}
        </p>
      )}

      {current.kind === 'ready' && (
        <div className="form-card stack">
          <div className="page-actions">
            <h1 className="heading">{current.subscription.name}</h1>
            {current.subscription.status === 'active-unknown' ? (
              <span className="badge-warning">Needs action</span>
            ) : (
              <span className="badge">{STATUS_LABEL[current.subscription.status]}</span>
            )}
          </div>
          <dl className="detail-list">
            <dt>Category</dt>
            <dd>{current.subscription.category}</dd>
            <dt>Cost</dt>
            <dd>{formatMoney(current.subscription.cost)}</dd>
            <dt>Type</dt>
            <dd>
              {current.subscription.billingPeriod
                ? `Recurring, ${PERIOD_LABEL[current.subscription.billingPeriod].toLowerCase()}`
                : 'One-time purchase'}
            </dd>
            <dt>Start date</dt>
            <dd>{current.subscription.startDate}</dd>
            <dt>{current.subscription.billingPeriod ? 'Next renewal' : 'Due'}</dt>
            <dd>{current.subscription.currentCycle?.dueDate ?? '—'}</dd>
            <dt>Payment method</dt>
            <dd>{PAYMENT_METHOD_LABEL[current.subscription.paymentMethod.type]}</dd>
            <dt>Renews automatically</dt>
            <dd>{current.subscription.autoRenews ? 'Yes' : 'No'}</dd>
            <dt>Renewal link</dt>
            <dd>
              <SafeLink href={current.subscription.renewalLink} />
            </dd>
            <dt>Cancellation link</dt>
            <dd>
              <SafeLink href={current.subscription.cancellationLink} />
            </dd>
          </dl>
        </div>
      )}
    </AppShell>
  )
}
