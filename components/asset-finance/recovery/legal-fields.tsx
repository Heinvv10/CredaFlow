"use client"

import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

// Controls of the legal-matter forms that register-form-controls does not cover:
// a select whose options can be greyed out, and a multi-line field.

export interface ChoiceOption { value: string; label: string; disabled?: boolean }

export function ChoiceField(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  options: ChoiceOption[]
  placeholder?: string
  required?: boolean
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={props.id} className="text-xs text-[var(--cf-text-secondary)]">
        {props.label}{props.required ? " *" : ""}
      </Label>
      <select
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="flex h-10 w-full min-w-0 rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-brand)]"
      >
        {props.placeholder !== undefined && <option value="">{props.placeholder}</option>}
        {props.options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
    </div>
  )
}

export function AreaField(props: { id: string; label: string; value: string; onChange: (value: string) => void; required?: boolean; rows?: number }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id} className="text-xs text-[var(--cf-text-secondary)]">
        {props.label}{props.required ? " *" : ""}
      </Label>
      <Textarea id={props.id} rows={props.rows ?? 2} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </div>
  )
}
