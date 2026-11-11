// The only place the app calls the API. The session lives in httpOnly cookies that the browser
// attaches by itself, so no token ever passes through this code.
const BASE = '/api/v1'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly field?: string

  constructor(status: number, code: string, message: string, field?: string) {
    super(message)
    this.status = status
    this.code = code
    this.field = field
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
}

// Told when a signed-in user's session can no longer be renewed (the AuthProvider listens).
let onSessionEnded: (() => void) | null = null
export function setSessionEndedHandler(handler: (() => void) | null) {
  onSessionEnded = handler
}

// A request with no answer after this long is abandoned, so a hung API cannot freeze the page.
const REQUEST_TIMEOUT_MS = 10_000

async function send(path: string, { method = 'GET', body }: RequestOptions): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin', // tells browser to add cookies.
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(0, 'TIMEOUT', 'The server took too long to respond. Please try again.')
    }
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.')
  }
}

// Expected failures arrive as { error: { code, message, field? } }; anything else becomes a generic error.
async function toApiError(res: Response): Promise<ApiError> {
  try {
    const { error } = await res.json()
    return new ApiError(res.status, error.code, error.message, error.field)
  } catch {
    return new ApiError(res.status, 'UNKNOWN_ERROR', 'Something went wrong. Please try again.')
  }
}

// Several requests can hit an expired session at once; they share one refresh, because the
// server rotates the refresh token and a second parallel refresh would fail.
let refreshing: Promise<boolean> | null = null
function refreshSession(): Promise<boolean> {
  refreshing ??= send('/auth/refresh', { method: 'POST' })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(path, options)

  // The 1-hour access token expired: renew it once and retry. The auth endpoints are excluded,
  // because a 401 from them is an answer (wrong password), not an expired session.
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) {
      res = await send(path, options)
    } else {
      onSessionEnded?.()
    }
  }

  if (!res.ok) throw await toApiError(res)
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
}

// What a form shows for any failure. Only ApiError messages are shown: they are written to be safe for users.
export function toFormError(err: unknown): { message: string; field?: string } {
  if (err instanceof ApiError) return { message: err.message, field: err.field }
  return { message: 'Something went wrong. Please try again.' }
}
