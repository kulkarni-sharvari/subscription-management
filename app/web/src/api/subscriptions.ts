import { api } from './client'

export type PaymentMethodType = 'credit_card' | 'debit_card' | 'apple_pay'
export type BillingPeriod = 'monthly' | '6_months' | 'annually'
export type SubscriptionType = 'recurring' | 'one_time'
export type SubscriptionStatus = 'active' | 'active-unknown' | 'inactive'

export interface PaymentMethod {
  id: string
  type: PaymentMethodType
  isActive: boolean
  createdAt: string
}

export interface Subscription {
  id: string
  name: string
  category: string
  cost: number
  billingPeriod: BillingPeriod | null
  subscriptionType: SubscriptionType
  status: SubscriptionStatus
  autoRenews: boolean
  paymentMethod: { id: string; type: PaymentMethodType }
  currentCycle: { dueDate: string; status: 'paid' | 'due' } | null
}

export interface SubscriptionDetail extends Subscription {
  renewalLink: string | null
  cancellationLink: string | null
  startDate: string
  createdAt: string
  updatedAt: string
  // The day a cancellation was recorded (Story 7); null unless inactive.
  cancelledOn: string | null
  // What "I renewed" can do now (Story 6). Worked out by the API in the user's time zone.
  renewal?: RenewalInfo
}

export type RenewalInfo =
  | { allowed: false; reason: 'inactive' | 'one_time' | 'too_early'; opensOn?: string }
  // missedDates: renewal dates already passed, oldest first. More than one: ask what happened.
  | { allowed: true; missedDates: string[]; nextDueIfPaidAll: string }

// Only what changed is sent; the API works out the new cycles itself.
export interface RenewalRequest {
  cost?: number
  paymentMethodId?: string
  billingPeriod?: BillingPeriod
  missed?: 'paid_all' | 'restarted'
  restartDate?: string
}

// One page of a list. nextCursor is null on the last page; otherwise pass it back for the next one.
export interface SubscriptionPage {
  items: Subscription[]
  nextCursor: string | null
}

export const STATUSES: readonly SubscriptionStatus[] = ['active', 'active-unknown', 'inactive']

export interface NewSubscription {
  name: string
  category: string
  cost: number
  subscriptionType: SubscriptionType
  billingPeriod?: BillingPeriod
  startDate: string
  paymentMethodId: string
  renewalLink?: string
  cancellationLink?: string
  autoRenews: boolean
}

export const PAYMENT_METHOD_LABEL: Record<PaymentMethodType, string> = {
  credit_card: 'Credit card',
  debit_card: 'Debit card',
  apple_pay: 'Apple Pay',
}

export const PERIOD_LABEL: Record<BillingPeriod, string> = {
  monthly: 'Monthly',
  '6_months': 'Every 6 months',
  annually: 'Annually',
}

export const listPaymentMethods = () => api.get<PaymentMethod[]>('/payment-methods')
export const createPaymentMethod = (type: PaymentMethodType) => api.post<PaymentMethod>('/payment-methods', { type })
export function listSubscriptions(status: SubscriptionStatus, cursor?: string | null) {
  const query = new URLSearchParams({ status })
  if (cursor) query.set('cursor', cursor)
  return api.get<SubscriptionPage>(`/subscriptions?${query}`)
}
export const getSubscription = (id: string) => api.get<SubscriptionDetail>(`/subscriptions/${encodeURIComponent(id)}`)
export const createSubscription = (body: NewSubscription) => api.post<Subscription>('/subscriptions', body)
// Story 8: only the fields that changed, plus the updatedAt the form was opened with. An empty
// link clears it. A 409 means the subscription changed since (another tab, a renewal).
export interface SubscriptionEdit {
  expectedUpdatedAt: string
  name?: string
  category?: string
  cost?: number
  billingPeriod?: BillingPeriod
  paymentMethodId?: string
  renewalLink?: string
  cancellationLink?: string
  autoRenews?: boolean
}
export const updateSubscription = (id: string, body: SubscriptionEdit) =>
  api.patch<SubscriptionDetail>(`/subscriptions/${encodeURIComponent(id)}`, body)

// Story 9: spending analytics for a date range (both days included).
export interface SpendingReport {
  range: { from: string; to: string }
  paid: {
    total: number
    payments: number
    byCategory: Array<{ category: string; total: number; payments: number }>
    byMonth: Array<{ month: string; total: number }>
    recurring: { total: number; payments: number }
    oneTime: { total: number; payments: number }
  }
  monthlyCost: { total: number; subscriptions: number; byCategory: Array<{ category: string; monthly: number }> }
  statusCounts: { active: number; activeUnknown: number; inactive: number }
  pendingReconciliation: Array<{ id: string; name: string; category: string; renewalDate: string | null; monthlyCost: number }>
}
export const getSpending = (from: string, to: string) =>
  api.get<SpendingReport>(`/analytics/spending?${new URLSearchParams({ from, to })}`)

// No body: the API records the cancellation date itself.
export const cancelSubscription = (id: string) => api.post<SubscriptionDetail>(`/subscriptions/${encodeURIComponent(id)}/cancel`)
// `key` is one UUID per renewal attempt, reused on a retry, so a double submit records once (SEC-041).
export const renewSubscription = (id: string, body: RenewalRequest, key: string) =>
  api.post<SubscriptionDetail>(`/subscriptions/${encodeURIComponent(id)}/renew`, body, { 'Idempotency-Key': key })

// One currency for the whole app (BR-011). Change it here if the account currency changes.
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
export const formatMoney = (value: number) => money.format(value)

// Form checks shared by the add and edit forms. They mirror the API's rules so mistakes are
// caught before a request is sent; the API checks everything again (this is not security).
export const COST_PATTERN = /^\d{1,8}(\.\d{1,2})?$/
const hasControlCharacter = (value: string) => /\p{Cc}/u.test(value)

export function checkText(label: string, raw: string, max: number): string | undefined {
  const value = raw.trim()
  if (!value) return `Enter the ${label}`
  if (value.length > max) return `The ${label} must be at most ${max} characters`
  if (hasControlCharacter(value)) return `The ${label} contains characters that are not allowed`
}

export function checkLink(label: string, raw: string): string | undefined {
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

export function checkCost(raw: string): string | undefined {
  const cost = raw.trim()
  if (!COST_PATTERN.test(cost)) return 'Enter the cost as a number with at most 2 decimal places'
  if (Number(cost) <= 0) return 'The cost must be greater than 0'
}

// Today as YYYY-MM-DD in the user's own calendar (not UTC, which can be a day off in the evening).
export function localToday(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// Dates travel as plain YYYY-MM-DD text and are shown as written, so no time zone can move the day.
const MONTHS_PER_PERIOD: Record<BillingPeriod, number> = { monthly: 1, '6_months': 6, annually: 12 }
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

export function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

// Only for the preview in the form. The API works out the real due date when the subscription is
// saved (the same rule: start date plus one period, clamped to the end of a shorter month).
export function previewDueDate(startDate: string, period: BillingPeriod): string {
  const [year, month, day] = startDate.split('-').map(Number)
  const monthIndex = year * 12 + (month - 1) + MONTHS_PER_PERIOD[period]
  const targetYear = Math.floor(monthIndex / 12)
  const targetMonth = (monthIndex % 12) + 1
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth))
  return [targetYear, targetMonth, targetDay].map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0')).join('-')
}
