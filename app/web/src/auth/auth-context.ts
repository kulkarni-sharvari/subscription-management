import { createContext, useContext } from 'react'

export interface User {
  id: string
  email: string
  createdAt: string
}

export interface AuthState {
  // 'loading' until the first GET /me answers; the guards wait for it.
  status: 'loading' | 'authenticated' | 'anonymous'
  user: User | null
  login: (email: string, password: string) => Promise<void>
  // Resolves with the message to show the user.
  register: (email: string, password: string) => Promise<string>
  confirmEmail: (tokenHash: string) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
