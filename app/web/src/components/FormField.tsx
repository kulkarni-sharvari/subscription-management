import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  error?: string
  hint?: string
}

// A label, an input and its message, wired together for screen readers.
export function FormField({ label, error, hint, ...inputProps }: FormFieldProps) {
  const id = useId()
  const messageId = `${id}-message`
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        {...inputProps}
      />
      {error ? (
        <p id={messageId} className="field-error">
          {error}
        </p>
      ) : (
        hint && (
          <p id={messageId} className="muted">
            {hint}
          </p>
        )
      )}
    </div>
  )
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string
  error?: string
  hint?: string
  children: ReactNode
}

// Same as FormField, for a drop-down list.
export function SelectField({ label, error, hint, children, ...selectProps }: SelectFieldProps) {
  const id = useId()
  const messageId = `${id}-message`
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        {...selectProps}
      >
        {children}
      </select>
      {error ? (
        <p id={messageId} className="field-error">
          {error}
        </p>
      ) : (
        hint && (
          <p id={messageId} className="muted">
            {hint}
          </p>
        )
      )}
    </div>
  )
}
