import type { ReactNode } from 'react'

interface AuthLayoutProps {
  title: string
  children: ReactNode
  // Line under the form, e.g. a link to the other auth screen.
  footer?: ReactNode
}

// The centred card shared by every signed-out screen.
export function AuthLayout({ title, children, footer }: AuthLayoutProps) {
  return (
    <main className="page-center">
      <div className="card stack">
        <h1 className="heading">{title}</h1>
        {children}
        {footer && <p className="muted">{footer}</p>}
      </div>
    </main>
  )
}
