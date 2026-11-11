import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError, setSessionEndedHandler } from '../api/client'
import { AuthContext, type AuthState, type User } from './auth-context'

// Holds "who is signed in". The browser cannot read the httpOnly session cookies, so the only
// way to know is to ask the API (GET /me); a 401 means nobody is signed in.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [status, setStatus] = useState<AuthState['status']>('loading')

  const loadUser = useCallback(async () => {
    try {
      const me = await api.get<User>('/me')
      setUser(me)
      setStatus('authenticated')
    } catch (err) {
      // Only a 401 means "signed out"; any other failure (server down) is not an answer.
      if (!(err instanceof ApiError) || err.status !== 401) throw err
      setUser(null)
      setStatus('anonymous')
    }
  }, [])

  // First load: is there already a valid session cookie (for example after a page refresh)?
  useEffect(() => {
    let cancelled = false
    api
      .get<User>('/me')
      .then((me) => {
        if (cancelled) return
        setUser(me)
        setStatus('authenticated')
      })
      .catch(() => {
        // 401 means signed out; if the API is unreachable the login screen is still the right place.
        if (!cancelled) setStatus('anonymous')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // If the session dies while the app is open, send the user back to the login screen.
  useEffect(() => {
    setSessionEndedHandler(() => {
      setUser(null)
      setStatus('anonymous')
    })
    return () => setSessionEndedHandler(null)
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      async login(email, password) {
        await api.post('/auth/login', { email, password })
        await loadUser()
      },
      async register(email, password) {
        const { message } = await api.post<{ message: string }>('/auth/register', { email, password })
        return message
      },
      async confirmEmail(tokenHash) {
        await api.post('/auth/confirm', { tokenHash })
        await loadUser()
      },
      async logout() {
        try {
          await api.post('/auth/logout')
        } finally {
          // Leave the signed-in screens even if the request failed; the server clears the cookies.
          setUser(null)
          setStatus('anonymous')
        }
      },
    }),
    [status, user, loadUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
