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
export const listSubscriptions = (status: SubscriptionStatus) => api.get<Subscription[]>(`/subscriptions?status=${status}`)
export const createSubscription = (body: NewSubscription) => api.post<Subscription>('/subscriptions', body)

// One currency for the whole app (BR-011). Change it here if the account currency changes.
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
export const formatMoney = (value: number) => money.format(value)

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
