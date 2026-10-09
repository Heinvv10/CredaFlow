import type { ReactNode } from "react"

interface FieldGroupProps {
  label: string
  required?: boolean
  error?: string
  children: ReactNode
  hint?: string
}

export function FieldGroup({ label, required, error, hint, children }: FieldGroupProps) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-[var(--cf-text-secondary)] mb-1.5">
        {label}
        {required && <span className="text-[var(--cf-danger)] ml-0.5">*</span>}
      </span>
      {children}
      {hint && !error && (
        <span className="block text-xs text-[var(--cf-text-muted)] mt-1">{hint}</span>
      )}
      {error && (
        <span className="block text-xs text-[var(--cf-danger)] mt-1" role="alert">
          {error}
        </span>
      )}
    </label>
  )
}
