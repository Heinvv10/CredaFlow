"use client"

import { Input } from "@/components/ui/input"

// Small labelled inputs for the asset-finance forms, on the --cf-* tokens.

export const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-brand)] disabled:cursor-not-allowed disabled:opacity-50"

const LABEL_CLASS = "mb-1.5 block text-xs font-semibold text-[var(--cf-text-secondary)]"

export function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="mt-1 text-xs text-[var(--cf-danger)]">{message}</p>
}

export function TextField(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  error?: string
  hint?: string
  type?: "text" | "date"
  inputMode?: "decimal" | "numeric" | "text"
  placeholder?: string
  required?: boolean
}) {
  return (
    <div>
      <label htmlFor={props.id} className={LABEL_CLASS}>
        {props.label}
        {props.required ? " *" : ""}
      </label>
      <Input
        id={props.id}
        type={props.type ?? "text"}
        inputMode={props.inputMode}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        aria-invalid={props.error ? true : undefined}
      />
      {props.hint && !props.error && <p className="mt-1 text-xs text-[var(--cf-text-muted)]">{props.hint}</p>}
      <FieldError message={props.error} />
    </div>
  )
}

export function SelectField<T extends string>(props: {
  id: string
  label: string
  value: T | ""
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  error?: string
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <div>
      <label htmlFor={props.id} className={LABEL_CLASS}>
        {props.label}
      </label>
      <select
        id={props.id}
        className={SELECT_CLASS}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value as T)}
      >
        {props.placeholder && <option value="">{props.placeholder}</option>}
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldError message={props.error} />
    </div>
  )
}

/** "1 234 567.89" → 123456789 cents; "" → null; anything else → undefined (invalid). */
export function randsToCents(text: string): number | null | undefined {
  const cleaned = text.replace(/[\s,]/g, "")
  if (cleaned === "") return null
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined
  const [whole, fraction = ""] = cleaned.split(".")
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
}

/** 123456789 cents → "1234567.89" for an input field. */
export function centsToRandsInput(cents: number | null): string {
  if (cents === null) return ""
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`
}
