// SEC-036 and SEC-035 in the browser: user text renders as text, links are safe, and the address
// bar cannot choose what the page asks the API for. The API is a fake fetch; nothing leaves the test.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './auth/AuthProvider'
import { AuthContext, type AuthState } from './auth/auth-context'
import Home from './pages/Home'
import SubscriptionDetail from './pages/SubscriptionDetail'

const EVIL = '<img src=x onerror="window.__pwned=1">'
const ID = '3f1c2b7e-8a53-4e0f-9d52-6b7c1f2a9e10'

const item = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: EVIL,
  category: '<script>window.__pwned=1</script>',
  cost: 15.49,
  billingPeriod: 'monthly',
  subscriptionType: 'recurring',
  status: 'active',
  autoRenews: true,
  paymentMethod: { id: 'p1', type: 'credit_card' },
  currentCycle: { dueDate: '2026-12-08', status: 'paid' },
  ...over,
})

const auth: AuthState = {
  status: 'authenticated',
  user: { id: 'u1', email: 'me@example.com', timeZone: 'UTC', createdAt: '2026-11-01' },
  login: async () => {},
  register: async () => '',
  confirmEmail: async () => {},
  logout: async () => {},
}

// Answers every request with the given body and records the URLs asked for.
function fakeApi(body: unknown, status = 200) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  return calls
}

function show(path: string) {
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/subscriptions/:id" element={<SubscriptionDetail />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (window as { __pwned?: number }).__pwned
})

describe('SEC-036: user-controlled text is shown as text, never as HTML', () => {
  it('the list shows markup in a name and category as plain characters', async () => {
    fakeApi({ items: [item()], nextCursor: null })
    const { container } = show('/')
    expect(await screen.findByText(EVIL)).toBeTruthy()
    expect(screen.getByText('<script>window.__pwned=1</script>')).toBeTruthy()
    expect(container.querySelector('img, script')).toBeNull()
    expect((window as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('the detail page does the same', async () => {
    fakeApi({ ...item(), renewalLink: null, cancellationLink: null, startDate: '2026-11-08', createdAt: '', updatedAt: '' })
    const { container } = show(`/subscriptions/${ID}`)
    expect(await screen.findByRole('heading', { name: EVIL })).toBeTruthy()
    expect(container.querySelector('img, script')).toBeNull()
  })
})

describe('SEC-035 / SEC-036: links', () => {
  const detail = (renewalLink: string | null, cancellationLink: string | null) =>
    fakeApi({ ...item({ name: 'Netflix' }), renewalLink, cancellationLink, startDate: '2026-11-08', createdAt: '', updatedAt: '' })

  it('a web link opens in a new tab with noopener and noreferrer', async () => {
    detail('https://example.com/renew', null)
    show(`/subscriptions/${ID}`)
    const link = (await screen.findByRole('link', { name: 'https://example.com/renew' })) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://example.com/renew')
    expect(link.target).toBe('_blank')
    expect(link.rel.split(' ').sort()).toEqual(['noopener', 'noreferrer'])
  })

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', ' javascript:alert(1)'])(
    'a stored %j is shown as text and is never a link',
    async (bad) => {
      detail(bad, null)
      const { container } = show(`/subscriptions/${ID}`)
      await screen.findByRole('heading', { name: 'Netflix' })
      const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
      expect(hrefs.some((h) => !/^(https?:\/\/|\/)/i.test(h))).toBe(false)
    },
  )
})

describe('the address bar cannot choose what the page asks for', () => {
  it.each(['evil', 'active%26sort=name', "active'--", ''])('?status=%s falls back to the active list', async (value) => {
    const calls = fakeApi({ items: [], nextCursor: null })
    show(`/?status=${value}`)
    await screen.findByText(/No active subscriptions yet/)
    expect(calls).toEqual(['/api/v1/subscriptions?status=active'])
  })

  it('a known status is passed through', async () => {
    const calls = fakeApi({ items: [], nextCursor: null })
    show('/?status=active-unknown')
    await screen.findByText(/Nothing needs your attention/)
    expect(calls).toEqual(['/api/v1/subscriptions?status=active-unknown'])
  })

  it('an id from the address is encoded, so it cannot reach another API path', async () => {
    const calls = fakeApi({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
    show('/subscriptions/..%2F..%2Fme')
    await screen.findByText('Subscription not found')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe('/api/v1/subscriptions/..%2F..%2Fme')
  })
})

describe("Story 4: the browser reports the user's time zone", () => {
  // Answers GET /me with the stored zone and records every request's method, path and body.
  function fakeMe(storedZone: string) {
    const calls: Array<{ method: string; url: string; body?: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(init.body as string) : undefined })
        const me = { id: 'u1', email: 'me@example.com', timeZone: storedZone, createdAt: '2026-11-01' }
        return new Response(JSON.stringify(me), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )
    return calls
  }
  const browserZone = (zone: string) =>
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: zone } as Intl.ResolvedDateTimeFormatOptions)

  it('sends the zone once when it differs from the stored one, and only the zone', async () => {
    browserZone('Asia/Kolkata')
    const calls = fakeMe('UTC')
    render(<AuthProvider><p>app</p></AuthProvider>)
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches).toEqual([{ method: 'PATCH', url: '/api/v1/me', body: { timeZone: 'Asia/Kolkata' } }])
  })

  it('sends nothing when the stored zone already matches', async () => {
    browserZone('UTC')
    const calls = fakeMe('UTC')
    render(<AuthProvider><p>app</p></AuthProvider>)
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/me')).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
  })
})

describe('Story 6: "I renewed"', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const detail = (over: Record<string, unknown> = {}) => ({
    ...item({ name: 'Netflix', category: 'TV', status: 'active-unknown', currentCycle: { dueDate: '2026-11-01', status: 'due' } }),
    renewalLink: null,
    cancellationLink: null,
    startDate: '2026-01-01',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    renewal: { allowed: true, missedDates: ['2026-11-01'], nextDueIfPaidAll: '2026-12-01' },
    ...over,
  })
  type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown }

  // Answers the detail, the payment methods and the renew call; `renewStatuses` sets the renew
  // answers in order (the last repeats). Records every request.
  function fakeRenewApi(sub: object, renewStatuses: number[] = [200]) {
    const calls: Call[] = []
    let renews = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({
          method: init.method ?? 'GET',
          url,
          headers: (init.headers ?? {}) as Record<string, string>,
          body: init.body ? JSON.parse(init.body as string) : undefined,
        })
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
        if (url.endsWith('/renew')) {
          const status = renewStatuses[Math.min(renews++, renewStatuses.length - 1)]
          if (status !== 200) return json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } }, status)
          return json({ ...sub, status: 'active', currentCycle: { dueDate: '2026-12-01', status: 'paid' }, renewal: { allowed: false, reason: 'too_early', opensOn: '2026-11-26' } })
        }
        if (url.endsWith('/payment-methods')) {
          return json([
            { id: 'p1', type: 'credit_card', isActive: true, createdAt: '' },
            { id: 'p2', type: 'debit_card', isActive: true, createdAt: '' },
          ])
        }
        return json(sub)
      }),
    )
    return calls
  }
  const renewCalls = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/renew'))
  const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Confirm renewal' }))

  it('explains what is needed, sends a UUID Idempotency-Key and an empty body when nothing changed', async () => {
    const calls = fakeRenewApi(detail())
    show(`/subscriptions/${ID}`)
    expect(await screen.findByText(/passed and you have not recorded what happened/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'I renewed' }))
    await screen.findByRole('option', { name: 'Debit card' })
    confirm()
    expect(await screen.findByText('Renewal recorded. Next renewal: 2026-12-01.')).toBeTruthy()
    const [call] = renewCalls(calls)
    expect(call.method).toBe('POST')
    expect(call.url).toBe(`/api/v1/subscriptions/${ID}/renew`)
    expect(call.headers['Idempotency-Key']).toMatch(UUID)
    expect(call.body).toEqual({})
  })

  it('SEC-041: a retry after a failure reuses the same key', async () => {
    const calls = fakeRenewApi(detail(), [500, 200])
    show(`/subscriptions/${ID}`)
    fireEvent.click(await screen.findByRole('button', { name: 'I renewed' }))
    confirm()
    expect(await screen.findByRole('alert')).toBeTruthy()
    confirm()
    await screen.findByText(/Renewal recorded/)
    const keys = renewCalls(calls).map((c) => c.headers['Idempotency-Key'])
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('only what changed is sent', async () => {
    const calls = fakeRenewApi(detail())
    show(`/subscriptions/${ID}`)
    fireEvent.click(await screen.findByRole('button', { name: 'I renewed' }))
    await screen.findByRole('option', { name: 'Debit card' })
    fireEvent.change(screen.getByLabelText('Cost'), { target: { value: '19.99' } })
    fireEvent.change(screen.getByLabelText('Payment method'), { target: { value: 'p2' } })
    confirm()
    await screen.findByText(/Renewal recorded/)
    expect(renewCalls(calls)[0].body).toEqual({ cost: 19.99, paymentMethodId: 'p2' })
  })

  it('with several missed dates it asks what happened before sending anything', async () => {
    const calls = fakeRenewApi(detail({ renewal: { allowed: true, missedDates: ['2026-09-01', '2026-10-01', '2026-11-01'], nextDueIfPaidAll: '2026-12-01' } }))
    show(`/subscriptions/${ID}`)
    fireEvent.click(await screen.findByRole('button', { name: 'I renewed' }))
    expect(await screen.findByText(/3 renewal dates have passed/)).toBeTruthy()
    confirm()
    expect(await screen.findByText('Choose what happened')).toBeTruthy()
    expect(renewCalls(calls)).toHaveLength(0)

    fireEvent.click(screen.getByLabelText('I kept paying on every date'))
    expect(screen.getByText(/Records 3 payments/)).toBeTruthy()
    confirm()
    await screen.findByText(/Renewal recorded/)
    expect(renewCalls(calls)[0].body).toEqual({ missed: 'paid_all' })
  })

  it('too early: no button, only when it opens', async () => {
    fakeRenewApi(detail({ status: 'active', currentCycle: { dueDate: '2026-12-20', status: 'paid' }, renewal: { allowed: false, reason: 'too_early', opensOn: '2026-12-15' } }))
    show(`/subscriptions/${ID}`)
    expect(await screen.findByText(/You can record this renewal from 2026-12-15/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'I renewed' })).toBeNull()
  })
})

describe('Story 7: "I cancelled"', () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    ...item({ name: 'Netflix', category: 'TV', status: 'active-unknown', currentCycle: { dueDate: '2026-11-01', status: 'due' } }),
    renewalLink: null,
    cancellationLink: 'javascript:alert(1)',
    startDate: '2026-01-01',
    cancelledOn: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    renewal: { allowed: true, missedDates: ['2026-11-01'], nextDueIfPaidAll: '2026-12-01' },
    ...over,
  })
  function fakeCancelApi(detail: object) {
    const calls: Array<{ method: string; url: string; body?: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ method: init.method ?? 'GET', url, body: init.body as string | undefined })
        const body = url.endsWith('/cancel') ? { ...detail, status: 'inactive', cancelledOn: '2026-11-23', renewal: { allowed: false, reason: 'inactive' } } : detail
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )
    return calls
  }

  it('asks for confirmation first, then sends a bodiless POST and shows the cancelled state', async () => {
    const calls = fakeCancelApi(sub())
    show(`/subscriptions/${ID}`)
    fireEvent.click(await screen.findByRole('button', { name: 'I cancelled' }))
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Yes, I cancelled it' }))
    expect(await screen.findByText(/Cancellation recorded/)).toBeTruthy()
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts).toEqual([{ method: 'POST', url: `/api/v1/subscriptions/${ID}/cancel`, body: undefined }])
    expect(screen.getByText('2026-11-23')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'I cancelled' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'I renewed' })).toBeNull()
  })

  it('SEC-035: a stored javascript: cancellation link in the confirmation is shown as text, not a link', async () => {
    fakeCancelApi(sub())
    const { container } = show(`/subscriptions/${ID}`)
    fireEvent.click(await screen.findByRole('button', { name: 'I cancelled' }))
    expect(container.querySelector('a[href^="javascript"]')).toBeNull()
  })

  it('an inactive subscription offers no cancel button', async () => {
    fakeCancelApi(sub({ status: 'inactive', cancelledOn: '2026-11-20', renewal: { allowed: false, reason: 'inactive' } }))
    show(`/subscriptions/${ID}`)
    expect(await screen.findByText('2026-11-20')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'I cancelled' })).toBeNull()
  })
})

