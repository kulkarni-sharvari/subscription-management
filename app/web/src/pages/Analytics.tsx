import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { toFormError } from '../api/client'
import { formatMoney, getSpending, isValidIsoDate, localToday, type SpendingReport } from '../api/subscriptions'
import { AppShell } from '../components/AppShell'
import { FormField, SelectField } from '../components/FormField'

// Story 9: spending analytics. "Paid in range" counts each payment on the day it was made, so a
// range matches a bank statement for the same dates; "monthly cost" is today's run rate of the
// active recurring subscriptions. Subscriptions that need action are listed apart, not counted.

type Preset = 'this_month' | 'last_3_months' | 'this_year' | 'last_12_months' | 'custom'
const PRESET_LABEL: Record<Preset, string> = {
  this_month: 'This month',
  last_3_months: 'Last 3 months',
  this_year: 'This year',
  last_12_months: 'Last 12 months',
  custom: 'Custom range',
}

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
// The range a preset means today, in the user's own calendar.
function presetRange(preset: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const now = new Date()
  const to = localToday()
  if (preset === 'this_month') return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to }
  if (preset === 'last_3_months') return { from: iso(new Date(now.getFullYear(), now.getMonth() - 3, now.getDate() + 1)), to }
  if (preset === 'this_year') return { from: `${now.getFullYear()}-01-01`, to }
  return { from: iso(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1)), to }
}

// The same limits as the API (SEC-038), checked first so the user sees why.
function checkRange(from: string, to: string): string | undefined {
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) return 'Enter both dates'
  if (from > to) return 'The start date must be on or before the end date'
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000
  if (days > 5 * 365 + 2) return 'The range can be at most 5 years'
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`

// One chart colour (single series per chart: no legend, the title names it). Validated against
// the white surface with the dataviz palette checks; text stays in the ink colours, never this.
const SERIES = '#2a78d6'
const INK_MUTED = '#475569'
const GRID = '#e2e8f0'

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="stat-tile">
      <p className="muted">{label}</p>
      <p className="stat-value">{value}</p>
      {detail && <p className="muted">{detail}</p>}
    </div>
  )
}

// A chart with its table view: the table carries the same numbers in text, for screen readers,
// copying, and anyone who cannot tell bar lengths apart.
function ChartCard({ title, rows, columns, children }: { title: string; rows: Array<[string, string]>; columns: [string, string]; children: React.ReactNode }) {
  return (
    <section className="chart-card stack" aria-label={title}>
      <h2 className="font-medium">{title}</h2>
      {children}
      <details>
        <summary className="link">Show as table</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{columns[0]}</th>
              <th scope="col">{columns[1]}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([a, b]) => (
              <tr key={a}>
                <td>{a}</td>
                <td>{b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  )
}

const money = (value: unknown) => formatMoney(Number(value))
const tooltipStyle = { border: `1px solid ${GRID}`, borderRadius: 8, fontSize: 13 }

// Horizontal bars for amounts per category: names read left to right, values labelled at the end.
function CategoryBars({ data, valueKey }: { data: Array<{ category: string } & Record<string, number | string>>; valueKey: string }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(120, data.length * 40 + 30)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 72, bottom: 4, left: 8 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="category" width={120} tickLine={false} axisLine={false} tick={{ fill: INK_MUTED, fontSize: 13 }} />
        <Tooltip formatter={money} cursor={{ fill: 'rgba(42,120,214,0.06)' }} contentStyle={tooltipStyle} />
        <Bar dataKey={valueKey} fill={SERIES} barSize={18} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          <LabelList dataKey={valueKey} position="right" formatter={money} style={{ fill: INK_MUTED, fontSize: 13 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// Each result remembers the range it is for; a result for another range means "still loading".
type LoadState = { key: string } & ({ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; report: SpendingReport })

export default function Analytics() {
  const [preset, setPreset] = useState<Preset>('last_12_months')
  const [custom, setCustom] = useState(() => presetRange('last_12_months'))
  const range = preset === 'custom' ? custom : presetRange(preset)
  const rangeError = preset === 'custom' ? checkRange(custom.from, custom.to) : undefined
  const key = `${range.from}|${range.to}`
  const [state, setState] = useState<LoadState>({ key: '', kind: 'loading' })

  useEffect(() => {
    if (rangeError) return
    let cancelled = false
    getSpending(range.from, range.to)
      .then((report) => !cancelled && setState({ key, kind: 'ready', report }))
      .catch((err: unknown) => !cancelled && setState({ key, kind: 'error', message: toFormError(err).message }))
    return () => {
      cancelled = true
    }
  }, [key, range.from, range.to, rangeError])
  const current: LoadState = state.key === key ? state : { key, kind: 'loading' }

  return (
    <AppShell>
      <h1 className="heading">Spending</h1>

      <div className="filter-row">
        <SelectField label="Period" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
          {Object.entries(PRESET_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        {preset === 'custom' && (
          <>
            <FormField label="From" type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <FormField label="To" type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </>
        )}
      </div>
      {rangeError && (
        <p role="alert" className="field-error">
          {rangeError}
        </p>
      )}

      {!rangeError && current.kind === 'loading' && <p className="muted">Loading…</p>}
      {!rangeError && current.kind === 'error' && (
        <p role="alert" className="alert-error">
          {current.message}
        </p>
      )}
      {!rangeError && current.kind === 'ready' && <Report report={current.report} />}
    </AppShell>
  )
}

function Report({ report }: { report: SpendingReport }) {
  const { paid, monthlyCost, pendingReconciliation } = report
  return (
    <>
      <p className="muted">
        {report.range.from} to {report.range.to}. Payments count on the day they were made.
      </p>

      <div className="stat-row">
        <StatTile label="Paid in this period" value={formatMoney(paid.total)} detail={`${paid.payments} ${paid.payments === 1 ? 'payment' : 'payments'}`} />
        <StatTile label="Recurring" value={formatMoney(paid.recurring.total)} detail={`${paid.recurring.payments} payments`} />
        <StatTile label="One-time" value={formatMoney(paid.oneTime.total)} detail={`${paid.oneTime.payments} purchases`} />
        <StatTile label="Monthly cost now" value={formatMoney(monthlyCost.total)} detail={`${monthlyCost.subscriptions} active subscriptions`} />
      </div>

      {pendingReconciliation.length > 0 && (
        <section className="alert-warning stack" aria-label="Pending reconciliation">
          <p className="font-medium">Pending reconciliation: not included in the monthly cost</p>
          <ul className="stack">
            {pendingReconciliation.map((p) => (
              <li key={p.id}>
                <Link to={`/subscriptions/${encodeURIComponent(p.id)}`} className="link">
                  {p.name}
                </Link>{' '}
                ({p.category}): renewal date {p.renewalDate ?? '—'} passed, {formatMoney(p.monthlyCost)} a month if it renewed
              </li>
            ))}
          </ul>
        </section>
      )}

      {paid.payments === 0 ? (
        <div className="empty-state">
          <p className="muted">No payments in this period.</p>
        </div>
      ) : (
        <div className="chart-grid">
          <ChartCard title="Paid per month" columns={['Month', 'Paid']} rows={paid.byMonth.map((m) => [monthLabel(m.month), formatMoney(m.total)])}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={paid.byMonth.map((m) => ({ ...m, label: monthLabel(m.month) }))} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: GRID }} tick={{ fill: INK_MUTED, fontSize: 12 }} />
                <YAxis tickFormatter={(v: number) => formatMoney(v)} tickLine={false} axisLine={false} tick={{ fill: INK_MUTED, fontSize: 12 }} width={80} />
                <Tooltip formatter={money} cursor={{ fill: 'rgba(42,120,214,0.06)' }} contentStyle={tooltipStyle} />
                <Bar dataKey="total" name="Paid" fill={SERIES} maxBarSize={36} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Paid by category" columns={['Category', 'Paid']} rows={paid.byCategory.map((c) => [c.category, formatMoney(c.total)])}>
            <CategoryBars data={paid.byCategory} valueKey="total" />
          </ChartCard>
        </div>
      )}

      {monthlyCost.byCategory.length > 0 && (
        <ChartCard title="Monthly cost by category (active subscriptions)" columns={['Category', 'Per month']} rows={monthlyCost.byCategory.map((c) => [c.category, formatMoney(c.monthly)])}>
          <CategoryBars data={monthlyCost.byCategory} valueKey="monthly" />
        </ChartCard>
      )}
    </>
  )
}
