"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// Form controls shared by the asset-register and supplier staff pages.

export function TextField(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  placeholder?: string
  inputMode?: "text" | "numeric" | "decimal"
  type?: "text" | "date" | "email"
  min?: string
  max?: string
  error?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id} className="text-xs text-[var(--cf-text-secondary)]">
        {props.label}{props.required ? " *" : ""}
      </Label>
      <Input
        id={props.id}
        type={props.type ?? "text"}
        inputMode={props.inputMode}
        value={props.value}
        placeholder={props.placeholder}
        min={props.min}
        max={props.max}
        onChange={(e) => props.onChange(e.target.value)}
        aria-invalid={props.error ? true : undefined}
      />
      {props.error && <p className="text-xs text-[var(--cf-danger)]">{props.error}</p>}
    </div>
  )
}

export function SelectField<T extends string>(props: {
  id: string
  label: string
  value: T
  onChange: (value: T) => void
  options: Record<T, string>
  required?: boolean
  error?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id} className="text-xs text-[var(--cf-text-secondary)]">
        {props.label}{props.required ? " *" : ""}
      </Label>
      <select
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value as T)}
        className="flex h-10 w-full rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-brand)]"
      >
        {(Object.keys(props.options) as T[]).map((key) => (
          <option key={key} value={key}>{props.options[key]}</option>
        ))}
      </select>
      {props.error && <p className="text-xs text-[var(--cf-danger)]">{props.error}</p>}
    </div>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div role="alert" className="rounded-md border border-[var(--cf-danger)] bg-[var(--cf-surface-soft)] p-3 text-sm text-[var(--cf-danger)]">
      {message}
    </div>
  )
}

export type SendResult = { ok: true; body: unknown } | { ok: false; error: string; fields: Record<string, string> }

/** Sends JSON to an asset-finance API route and reads the route's `{ error, fields }` refusal shape. */
export async function sendJson(url: string, method: "POST" | "PATCH" | "PUT", body: unknown): Promise<SendResult> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> }
    if (res.ok) return { ok: true, body: data }
    return { ok: false, error: data.error ?? `Request failed (${res.status})`, fields: data.fields ?? {} }
  } catch {
    return { ok: false, error: "Network error — try again", fields: {} }
  }
}
