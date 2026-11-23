import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { toFormError } from '../api/client'
import {
  createPaymentMethod,
  createSubscription,
  isValidIsoDate,
  listPaymentMethods,
  localToday,
  PAYMENT_METHOD_LABEL,
  PERIOD_LABEL,
  previewDueDate,
  type BillingPeriod,
  type NewSubscription,
  type PaymentMethod,
  type PaymentMethodType,
  type SubscriptionType,
} from '../api/subscriptions'
import { AppShell } from '../components/AppShell'
import { FormField, SelectField } from '../components/FormField'

interface Values {
  name: string
  category: string
  subscriptionType: SubscriptionType
  billingPeriod: BillingPeriod
  startDate: string
  cost: string
  paymentMethodId: string
  renewalLink: string
  cancellationLink: string
  autoRenews: boolean
}
type Errors = Partial<Record<keyof Values, string>>

// These rules mirror the API's, so mistakes are caught before a request is sent. The API checks
// everything again: this is for the user's convenience, not for security.
const hasControlCharacter = (value: string) => /\p{Cc}/u.test(value)

function checkText(label: string, raw: string, max: number): string | undefined {
  const value = raw.trim()
  if (!value) return `Enter the ${label}`
  if (value.length > max) return `The ${label} must be at most ${max} characters`
  if (hasControlCharacter(value)) return `The ${label} contains characters that are not allowed`
}

function checkLink(label: string, raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return undefined
  const message = `The ${label} must be a valid http or https address`
  if (value.length > 2048) return `The ${label} must be at most 2048 characters`
  if (!/^https?:\/\//i.test(value)) return message
  try {
    const url = new URL(value)
    if (url.username || url.password) return message
  } catch {
    return message
  }
}

const COST_PATTERN = /^\d{1,8}(\.\d{1,2})?$/

function validate(v: Values): Errors {
  const errors: Errors = {}
  errors.name = checkText('subscription name', v.name, 100)
  errors.category = checkText('category', v.category, 50)

  const cost = v.cost.trim()
  if (!COST_PATTERN.test(cost)) errors.cost = 'Enter the cost as a number with at most 2 decimal places'
  else if (Number(cost) <= 0) errors.cost = 'The cost must be greater than 0'

  if (!isValidIsoDate(v.startDate)) errors.startDate = 'Enter a valid start date'
  else if (v.startDate < '2000-01-01' || v.startDate > '2100-12-31') errors.startDate = 'The start date must be between 2000 and 2100'

  if (!v.paymentMethodId) errors.paymentMethodId = 'Choose a payment method'
  errors.renewalLink = checkLink('renewal link', v.renewalLink)
  errors.cancellationLink = checkLink('cancellation link', v.cancellationLink)

  // Drop the keys with no problem, so "has any error" is simply "has any key".
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message)) as Errors
}

type MethodsState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; methods: PaymentMethod[] }

// A payment method is a type only (no card numbers are ever stored), so adding one is one choice.
function AddPaymentMethod({ onAdded, onCancel }: { onAdded: (method: PaymentMethod) => void; onCancel?: () => void }) {
  const [type, setType] = useState<PaymentMethodType>('credit_card')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    setBusy(true)
    setError(null)
    try {
      onAdded(await createPaymentMethod(type))
    } catch (err) {
      setError(toFormError(err).message)
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <SelectField label="Payment method type" value={type} onChange={(e) => setType(e.target.value as PaymentMethodType)}>
        {Object.entries(PAYMENT_METHOD_LABEL).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <button type="button" className="btn-secondary" onClick={() => void add()} disabled={busy}>
          {busy ? 'Adding…' : 'Add payment method'}
        </button>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

export default function AddSubscription() {
  const navigate = useNavigate()
  const [values, setValues] = useState<Values>(() => ({
    name: '',
    category: '',
    subscriptionType: 'recurring',
    billingPeriod: 'monthly',
    startDate: localToday(),
    cost: '',
    paymentMethodId: '',
    renewalLink: '',
    cancellationLink: '',
    autoRenews: true,
  }))
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [methods, setMethods] = useState<MethodsState>({ kind: 'loading' })
  const [addingMethod, setAddingMethod] = useState(false)

  useEffect(() => {
    let cancelled = false
    listPaymentMethods()
      .then((list) => {
        if (cancelled) return
        setMethods({ kind: 'ready', methods: list })
        // With exactly one payment method there is nothing to choose.
        if (list.length === 1) setValues((v) => ({ ...v, paymentMethodId: list[0].id }))
      })
      .catch((err: unknown) => {
        if (!cancelled) setMethods({ kind: 'error', message: toFormError(err).message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((v) => ({ ...v, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined }))
  }

  function chooseType(type: SubscriptionType) {
    // A one-time purchase has no billing period and does not renew.
    setValues((v) => ({ ...v, subscriptionType: type, autoRenews: type === 'recurring' }))
    setErrors((e) => ({ ...e, billingPeriod: undefined }))
  }

  function methodAdded(method: PaymentMethod) {
    setMethods((m) => ({ kind: 'ready', methods: m.kind === 'ready' ? [...m.methods, method] : [method] }))
    set('paymentMethodId', method.id)
    setAddingMethod(false)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setFormError(null)
    const found = validate(values)
    setErrors(found)
    if (Object.keys(found).length > 0) return

    const recurring = values.subscriptionType === 'recurring'
    const body: NewSubscription = {
      name: values.name.trim(),
      category: values.category.trim(),
      cost: Number(values.cost.trim()),
      subscriptionType: values.subscriptionType,
      startDate: values.startDate,
      paymentMethodId: values.paymentMethodId,
      autoRenews: recurring && values.autoRenews,
      ...(recurring && { billingPeriod: values.billingPeriod }),
      ...(values.renewalLink.trim() && { renewalLink: values.renewalLink.trim() }),
      ...(values.cancellationLink.trim() && { cancellationLink: values.cancellationLink.trim() }),
    }

    setSubmitting(true)
    try {
      const created = await createSubscription(body)
      navigate('/', { replace: true, state: { added: created.name } })
    } catch (err) {
      const { message, field } = toFormError(err)
      // A problem the API ties to one field is shown beside it; anything else at the top.
      if (field && field in values) setErrors({ [field]: message })
      else setFormError(message)
      setSubmitting(false)
    }
  }

  const recurring = values.subscriptionType === 'recurring'
  const previewReady = isValidIsoDate(values.startDate)
  const noMethods = methods.kind === 'ready' && methods.methods.length === 0

  return (
    <AppShell>
      <div className="form-card stack">
        <h1 className="heading">Add a subscription</h1>

        {methods.kind === 'loading' && <p className="muted">Loading…</p>}
        {methods.kind === 'error' && (
          <p role="alert" className="alert-error">
            {methods.message}
          </p>
        )}

        {noMethods && (
          <div className="stack">
            <p>Add a payment method first. You will pick it for each subscription.</p>
            <AddPaymentMethod onAdded={methodAdded} />
          </div>
        )}

        {methods.kind === 'ready' && !noMethods && (
          <form className="stack" onSubmit={(e) => void handleSubmit(e)} noValidate>
            <fieldset className="field">
              <legend className="label">Type</legend>
              <div className="radio-group">
                <label className="radio-row">
                  <input type="radio" name="subscriptionType" checked={recurring} onChange={() => chooseType('recurring')} />
                  Recurring subscription
                </label>
                <label className="radio-row">
                  <input type="radio" name="subscriptionType" checked={!recurring} onChange={() => chooseType('one_time')} />
                  One-time purchase
                </label>
              </div>
            </fieldset>

            <FormField label="Name" name="name" maxLength={100} value={values.name} error={errors.name} onChange={(e) => set('name', e.target.value)} />
            <FormField label="Category" name="category" maxLength={50} value={values.category} error={errors.category} onChange={(e) => set('category', e.target.value)} />
            <FormField
              label="Cost"
              name="cost"
              inputMode="decimal"
              placeholder="15.49"
              value={values.cost}
              error={errors.cost}
              onChange={(e) => set('cost', e.target.value)}
            />

            {recurring && (
              <SelectField label="Billing period" value={values.billingPeriod} error={errors.billingPeriod} onChange={(e) => set('billingPeriod', e.target.value as BillingPeriod)}>
                {Object.entries(PERIOD_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </SelectField>
            )}

            <FormField
              label={recurring ? 'Start date' : 'Purchase date'}
              type="date"
              name="startDate"
              min="2000-01-01"
              max="2100-12-31"
              value={values.startDate}
              error={errors.startDate}
              hint={
                previewReady
                  ? recurring
                    ? `Next renewal: ${previewDueDate(values.startDate, values.billingPeriod)} (confirmed when you save)`
                    : 'Due on this date'
                  : undefined
              }
              onChange={(e) => set('startDate', e.target.value)}
            />

            <div className="stack">
              <SelectField label="Payment method" value={values.paymentMethodId} error={errors.paymentMethodId} onChange={(e) => set('paymentMethodId', e.target.value)}>
                <option value="">Choose…</option>
                {methods.methods.map((method) => (
                  <option key={method.id} value={method.id}>
                    {PAYMENT_METHOD_LABEL[method.type]} (added {new Date(method.createdAt).toLocaleDateString()})
                  </option>
                ))}
              </SelectField>
              {addingMethod ? (
                <AddPaymentMethod onAdded={methodAdded} onCancel={() => setAddingMethod(false)} />
              ) : (
                <div>
                  <button type="button" className="link" onClick={() => setAddingMethod(true)}>
                    Add another payment method
                  </button>
                </div>
              )}
            </div>

            <FormField label="Renewal link (optional)" name="renewalLink" inputMode="url" placeholder="https://" value={values.renewalLink} error={errors.renewalLink} onChange={(e) => set('renewalLink', e.target.value)} />
            <FormField label="Cancellation link (optional)" name="cancellationLink" inputMode="url" placeholder="https://" value={values.cancellationLink} error={errors.cancellationLink} onChange={(e) => set('cancellationLink', e.target.value)} />

            {recurring && (
              <label className="check-row">
                <input type="checkbox" checked={values.autoRenews} onChange={(e) => set('autoRenews', e.target.checked)} />
                Renews automatically
              </label>
            )}

            {formError && (
              <p role="alert" className="alert-error">
                {formError}
              </p>
            )}
            <div className="flex gap-3">
              <button type="submit" className="btn-primary" disabled={submitting}>
                {submitting ? 'Saving…' : 'Add subscription'}
              </button>
              <Link to="/" className="btn-secondary">
                Cancel
              </Link>
            </div>
          </form>
        )}
      </div>
    </AppShell>
  )
}
