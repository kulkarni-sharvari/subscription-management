// SEC-036 and SEC-035 in the browser: user text renders as text, links are safe, and the address
// bar cannot choose what the page asks the API for. The API is a fake fetch; nothing leaves the test.
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  user: { id: 'u1', email: 'me@example.com', createdAt: '2026-11-01' },
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
