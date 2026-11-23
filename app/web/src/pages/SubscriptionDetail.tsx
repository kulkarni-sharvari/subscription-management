import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError, toFormError } from '../api/client'
import {
  checkCost,
  checkLink,
  checkText,
  formatMoney,
  getSubscription,
  isValidIsoDate,
  listPaymentMethods,
  localToday,
  PAYMENT_METHOD_LABEL,
  PERIOD_LABEL,
  previewDueDate,
  cancelSubscription,
  renewSubscription,
  updateSubscription,
  type BillingPeriod,
  type PaymentMethod,
  type RenewalRequest,
  type SubscriptionEdit,
  type SubscriptionDetail as Detail,
} from '../api/subscriptions'
import { AppShell } from '../components/AppShell'
import { FormField, SelectField } from '../components/FormField'

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

interface RenewValues {
  missed: '' | 'paid_all' | 'restarted'
  restartDate: string
  cost: string
  paymentMethodId: string
  billingPeriod: BillingPeriod
}
type RenewErrors = Partial<Record<keyof RenewValues, string>>

// The "I renewed" form (Story 6). It asks "what happened?" only when more than one renewal date
// has passed, and sends only what changed. The API checks everything again and works out the
// new cycles itself; the dates shown here are a preview.
function RenewForm({ sub, missedDates, onDone, onCancel }: { sub: Detail; missedDates: string[]; onDone: (updated: Detail) => void; onCancel: () => void }) {
  // One key per attempt, kept across retries: a double click or a retry after a network error
  // records one renewal (SEC-041). Opening the form again starts a new attempt.
  const [key] = useState(() => crypto.randomUUID())
  const [values, setValues] = useState<RenewValues>({
    missed: '',
    restartDate: '',
    cost: String(sub.cost),
    paymentMethodId: sub.paymentMethod.id,
    billingPeriod: sub.billingPeriod ?? 'monthly',
  })
  const choices = useMethodChoices(sub)
  const [errors, setErrors] = useState<RenewErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const severalMissed = missedDates.length > 1
  const today = localToday()

  const set = <K extends keyof RenewValues>(name: K, value: RenewValues[K]) => setValues((v) => ({ ...v, [name]: value }))

  function validate(): RenewErrors {
    const e: RenewErrors = {}
    if (severalMissed && !values.missed) e.missed = 'Choose what happened'
    if (values.missed === 'restarted') {
      if (!isValidIsoDate(values.restartDate)) e.restartDate = 'Enter the date you restarted'
      else if (values.restartDate <= missedDates[0] || values.restartDate > today) e.restartDate = `The date must be after ${missedDates[0]} and not in the future`
    }
    e.cost = checkCost(values.cost)
    return Object.fromEntries(Object.entries(e).filter(([, m]) => m)) as RenewErrors
  }

  // What the user will see after saving, before they confirm.
  const lastPaidOn = missedDates.at(-1) ?? sub.currentCycle?.dueDate
  let preview = ''
  if (values.missed === 'restarted') preview = isValidIsoDate(values.restartDate) ? 'Payments are recorded from the restart date; the time before it stays unpaid.' : ''
  else if (lastPaidOn && (!severalMissed || values.missed === 'paid_all')) {
    const payments = Math.max(missedDates.length, 1)
    preview = `${payments === 1 ? 'Records 1 payment' : `Records ${payments} payments (${missedDates.join(', ')})`}. Next renewal: ${previewDueDate(lastPaidOn, values.billingPeriod)}.`
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const found = validate()
    setErrors(found)
    setFormError(null)
    if (Object.keys(found).length > 0) return

    const body: RenewalRequest = {}
    if (Number(values.cost) !== sub.cost) body.cost = Number(values.cost)
    if (values.paymentMethodId !== sub.paymentMethod.id) body.paymentMethodId = values.paymentMethodId
    if (values.billingPeriod !== sub.billingPeriod) body.billingPeriod = values.billingPeriod
    if (values.missed) body.missed = values.missed
    if (values.missed === 'restarted') body.restartDate = values.restartDate

    setSubmitting(true)
    try {
      onDone(await renewSubscription(sub.id, body, key))
    } catch (err) {
      const { message, field } = toFormError(err)
      if (field && field in values) setErrors({ [field]: message })
      else setFormError(message)
      setSubmitting(false)
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate aria-label="Record a renewal">
      <h2 className="font-medium">Record a renewal</h2>

      {severalMissed && (
        <fieldset className="stack">
          <legend className="label">
            {missedDates.length} renewal dates have passed ({missedDates.join(', ')}). What happened?
          </legend>
          <div className="radio-stack">
            <label className="radio-row">
              <input type="radio" name="missed" checked={values.missed === 'paid_all'} onChange={() => set('missed', 'paid_all')} />
              I kept paying on every date
            </label>
            <label className="radio-row">
              <input type="radio" name="missed" checked={values.missed === 'restarted'} onChange={() => set('missed', 'restarted')} />
              I stopped, then restarted on a date
            </label>
          </div>
          {errors.missed && <p className="field-error">{errors.missed}</p>}
          {values.missed === 'restarted' && (
            <FormField label="Date you restarted" type="date" value={values.restartDate} min={missedDates[0]} max={today} error={errors.restartDate} onChange={(e) => set('restartDate', e.target.value)} />
          )}
        </fieldset>
      )}

      <p className="muted">Change these only if they changed. They apply from this renewal on{severalMissed ? '; earlier payments keep the old values' : ''}.</p>
      <FormField label="Cost" inputMode="decimal" value={values.cost} error={errors.cost} onChange={(e) => set('cost', e.target.value)} />
      <SelectField label="Payment method" value={values.paymentMethodId} error={errors.paymentMethodId} onChange={(e) => set('paymentMethodId', e.target.value)}>
        {choices.map((m) => (
          <option key={m.id} value={m.id}>
            {PAYMENT_METHOD_LABEL[m.type]}
            {m.id === sub.paymentMethod.id ? ' (current)' : ''}
          </option>
        ))}
      </SelectField>
      <SelectField label="Billing period" value={values.billingPeriod} onChange={(e) => set('billingPeriod', e.target.value as BillingPeriod)}>
        {Object.entries(PERIOD_LABEL).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>

      {preview && <p className="muted">{preview}</p>}
      {formError && (
        <p role="alert" className="alert-error">
          {formError}
        </p>
      )}
      <div className="flex gap-3">
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : 'Confirm renewal'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// "I cancelled" (Story 7): the confirmation step. If a cancellation link is saved it is offered
// first: recording a cancellation here does not cancel anything with the provider.
function CancelConfirm({ sub, onDone, onBack }: { sub: Detail; onDone: (updated: Detail) => void; onBack: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      onDone(await cancelSubscription(sub.id))
    } catch (err) {
      setError(toFormError(err).message)
      setBusy(false)
    }
  }

  return (
    <div className="stack" role="group" aria-label="Record a cancellation">
      <p>
        Mark <strong>{sub.name}</strong> as cancelled? It moves to Inactive, reminders stop, and its history is kept.
      </p>
      {sub.cancellationLink && (
        <p className="muted">
          This only records it here. Cancel with the provider first: <SafeLink href={sub.cancellationLink} />
        </p>
      )}
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <button type="button" className="btn-danger" onClick={() => void confirm()} disabled={busy}>
          {busy ? 'Saving…' : 'Yes, I cancelled it'}
        </button>
        <button type="button" className="btn-secondary" onClick={onBack} disabled={busy}>
          Back
        </button>
      </div>
    </div>
  )
}

// What the detail page offers: the explanation, then "I renewed" and "I cancelled" on one line,
// right-aligned. Opening one replaces the line with its form.
function Actions({ sub, onRenewed, onCancelled }: { sub: Detail; onRenewed: (u: Detail) => void; onCancelled: (u: Detail) => void }) {
  const [mode, setMode] = useState<'idle' | 'renewing' | 'cancelling'>('idle')
  if (sub.status === 'inactive') return null
  const renewal = sub.renewal
  const canRenew = renewal?.allowed === true

  if (mode === 'renewing' && renewal?.allowed) {
    return <RenewForm sub={sub} missedDates={renewal.missedDates} onCancel={() => setMode('idle')} onDone={(u) => { setMode('idle'); onRenewed(u) }} />
  }
  if (mode === 'cancelling') {
    return <CancelConfirm sub={sub} onBack={() => setMode('idle')} onDone={(u) => { setMode('idle'); onCancelled(u) }} />
  }
  return (
    <div className="stack">
      {sub.status === 'active-unknown' && renewal?.allowed && (
        <p className="alert-warning">
          The renewal date ({renewal.missedDates[0]}) passed and you have not recorded what happened. Record whether it renewed or you
          cancelled it, so its dates and costs stay accurate.
        </p>
      )}
      {renewal && !renewal.allowed && renewal.reason === 'too_early' && (
        <p className="muted">You can record this renewal from {renewal.opensOn}, 5 days before it renews.</p>
      )}
      <div className="action-row">
        {canRenew && (
          <button type="button" className="btn-primary" onClick={() => setMode('renewing')}>
            I renewed
          </button>
        )}
        <button type="button" className="btn-danger" onClick={() => setMode('cancelling')}>
          I cancelled
        </button>
      </div>
    </div>
  )
}

// The payment methods a form may offer: the active ones, plus the current one even if it was
// deactivated since (so the form never silently changes it).
function useMethodChoices(sub: Detail): PaymentMethod[] {
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null)
  useEffect(() => {
    let cancelled = false
    listPaymentMethods()
      .then((list) => !cancelled && setMethods(list))
      .catch(() => !cancelled && setMethods([]))
    return () => {
      cancelled = true
    }
  }, [])
  const choices = (methods ?? []).filter((m) => m.isActive || m.id === sub.paymentMethod.id)
  if (!choices.some((m) => m.id === sub.paymentMethod.id)) choices.unshift({ id: sub.paymentMethod.id, type: sub.paymentMethod.type, isActive: true, createdAt: '' })
  return choices
}

interface EditValues {
  name: string
  category: string
  cost: string
  billingPeriod: BillingPeriod
  paymentMethodId: string
  renewalLink: string
  cancellationLink: string
  autoRenews: boolean
}
type EditErrors = Partial<Record<keyof EditValues, string>>

// Story 8: the details become inputs in place. Start date, next renewal and status are shown but
// not editable (they change only through renew, cancel and the lapse). Only changed fields are
// sent, with the updatedAt the form opened with, so a stale save is refused (409), not applied.
function EditForm({ sub, onSaved, onDiscard, onReload }: { sub: Detail; onSaved: (u: Detail) => void; onDiscard: () => void; onReload: () => void }) {
  const initial: EditValues = {
    name: sub.name,
    category: sub.category,
    cost: String(sub.cost),
    billingPeriod: sub.billingPeriod ?? 'monthly',
    paymentMethodId: sub.paymentMethod.id,
    renewalLink: sub.renewalLink ?? '',
    cancellationLink: sub.cancellationLink ?? '',
    autoRenews: sub.autoRenews,
  }
  const [values, setValues] = useState<EditValues>(initial)
  const [errors, setErrors] = useState<EditErrors>({})
  const [formError, setFormError] = useState<{ message: string; stale: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const choices = useMethodChoices(sub)
  const set = <K extends keyof EditValues>(name: K, value: EditValues[K]) => setValues((v) => ({ ...v, [name]: value }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    const found: EditErrors = {
      name: checkText('subscription name', values.name, 100),
      category: checkText('category', values.category, 50),
      cost: checkCost(values.cost),
      renewalLink: checkLink('renewal link', values.renewalLink),
      cancellationLink: checkLink('cancellation link', values.cancellationLink),
    }
    const real = Object.fromEntries(Object.entries(found).filter(([, m]) => m)) as EditErrors
    setErrors(real)
    setFormError(null)
    if (Object.keys(real).length > 0) return

    const body: SubscriptionEdit = { expectedUpdatedAt: sub.updatedAt }
    if (values.name.trim() !== initial.name) body.name = values.name.trim()
    if (values.category.trim() !== initial.category) body.category = values.category.trim()
    if (Number(values.cost) !== sub.cost) body.cost = Number(values.cost)
    if (sub.billingPeriod && values.billingPeriod !== sub.billingPeriod) body.billingPeriod = values.billingPeriod
    if (values.paymentMethodId !== initial.paymentMethodId) body.paymentMethodId = values.paymentMethodId
    if (values.renewalLink.trim() !== initial.renewalLink) body.renewalLink = values.renewalLink.trim()
    if (values.cancellationLink.trim() !== initial.cancellationLink) body.cancellationLink = values.cancellationLink.trim()
    if (values.autoRenews !== initial.autoRenews) body.autoRenews = values.autoRenews
    if (Object.keys(body).length === 1) return onDiscard() // nothing changed

    setSaving(true)
    try {
      onSaved(await updateSubscription(sub.id, body))
    } catch (err) {
      const stale = err instanceof ApiError && err.status === 409
      const { message, field } = toFormError(err)
      if (!stale && field && field in values) setErrors({ [field]: message })
      else setFormError({ message, stale })
      setSaving(false)
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate aria-label="Edit subscription">
      <FormField label="Name" value={values.name} error={errors.name} onChange={(e) => set('name', e.target.value)} />
      <FormField label="Category" value={values.category} error={errors.category} onChange={(e) => set('category', e.target.value)} />
      <FormField label="Cost" inputMode="decimal" value={values.cost} error={errors.cost} hint="Applies from the next renewal" onChange={(e) => set('cost', e.target.value)} />
      {sub.billingPeriod && (
        <SelectField label="Billing period" value={values.billingPeriod} hint="Applies from the next renewal" onChange={(e) => set('billingPeriod', e.target.value as BillingPeriod)}>
          {Object.entries(PERIOD_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
      )}
      <SelectField label="Payment method" value={values.paymentMethodId} error={errors.paymentMethodId} onChange={(e) => set('paymentMethodId', e.target.value)}>
        {choices.map((m) => (
          <option key={m.id} value={m.id}>
            {PAYMENT_METHOD_LABEL[m.type]}
            {m.id === sub.paymentMethod.id ? ' (current)' : ''}
          </option>
        ))}
      </SelectField>
      <label className="check-row">
        <input type="checkbox" checked={values.autoRenews} onChange={(e) => set('autoRenews', e.target.checked)} />
        Renews automatically
      </label>
      <FormField label="Renewal link" type="url" value={values.renewalLink} error={errors.renewalLink} hint="Leave empty to remove it" onChange={(e) => set('renewalLink', e.target.value)} />
      <FormField label="Cancellation link" type="url" value={values.cancellationLink} error={errors.cancellationLink} hint="Leave empty to remove it" onChange={(e) => set('cancellationLink', e.target.value)} />

      <dl className="detail-list">
        <dt>Start date</dt>
        <dd>{sub.startDate}</dd>
        <dt>{sub.billingPeriod ? 'Next renewal' : 'Due'}</dt>
        <dd>{sub.currentCycle?.dueDate ?? '—'}</dd>
      </dl>
      <p className="muted">The start date and next renewal change only when you record a renewal or a cancellation.</p>

      {formError && (
        <div role="alert" className="alert-error stack">
          <span>{formError.message}</span>
          {formError.stale && (
            <div>
              <button type="button" className="btn-secondary" onClick={onReload}>
                Reload
              </button>
            </div>
          )}
        </div>
      )}
      <div className="action-row">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Update'}
        </button>
        <button type="button" className="btn-secondary" onClick={onDiscard} disabled={saving}>
          Discard changes
        </button>
      </div>
    </form>
  )
}

// A pencil, drawn inline (no icon library). Hidden from screen readers: the button has a label.
function PencilIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="currentColor">
      <path d="M13.6 2.6a2 2 0 0 1 2.8 0l1 1a2 2 0 0 1 0 2.8l-9.9 9.9-4 1.1a.6.6 0 0 1-.7-.7l1.1-4 9.7-10.1Zm-8.4 11 .9.9 8.6-8.6-.9-.9-8.6 8.6Z" />
    </svg>
  )
}

export default function SubscriptionDetail() {
  const { id = '' } = useParams()
  const [state, setState] = useState<DetailState>({ kind: 'loading', id })
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  // Bumped to load the subscription again (after a stale save).
  const [loads, setLoads] = useState(0)

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
  }, [id, loads])

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
            <div className="flex items-center gap-3">
              {current.subscription.status === 'active-unknown' ? (
                <span className="badge-warning">Needs action</span>
              ) : (
                <span className="badge">{STATUS_LABEL[current.subscription.status]}</span>
              )}
              {!editing && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Edit details"
                  title="Edit details"
                  onClick={() => {
                    setNotice(null)
                    setEditing(true)
                  }}
                >
                  <PencilIcon />
                </button>
              )}
            </div>
          </div>
          {editing ? (
            <EditForm
              sub={current.subscription}
              onDiscard={() => setEditing(false)}
              onReload={() => {
                setEditing(false)
                setLoads((n) => n + 1)
              }}
              onSaved={(updated) => {
                setState({ kind: 'ready', id, subscription: updated })
                setEditing(false)
                setNotice('Changes saved.')
              }}
            />
          ) : (
          <>
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
            {current.subscription.cancelledOn && (
              <>
                <dt>Cancelled on</dt>
                <dd>{current.subscription.cancelledOn}</dd>
              </>
            )}
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
          {notice && (
            <p role="status" className="alert-success">
              {notice}
            </p>
          )}
          <Actions
            sub={current.subscription}
            onRenewed={(updated) => {
              setState({ kind: 'ready', id, subscription: updated })
              setNotice(`Renewal recorded. Next renewal: ${updated.currentCycle?.dueDate ?? '—'}.`)
            }}
            onCancelled={(updated) => {
              setState({ kind: 'ready', id, subscription: updated })
              setNotice('Cancellation recorded. It is now inactive and you will get no more reminders for it.')
            }}
          />
          </>
          )}
        </div>
      )}
    </AppShell>
  )
}
