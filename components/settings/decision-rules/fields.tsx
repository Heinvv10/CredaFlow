"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import type { Scalar } from "@/lib/decisioning/types"

interface NumberFieldProps {
  label: string
  value: number
  onChange: (value: number) => void
  className?: string
  id?: string
  min?: number
  max?: number
}

const parseNumber = (text: string): number | null => {
  const trimmed = text.trim()
  if (trimmed === "") return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

/**
 * A number input that keeps what is typed until it parses. A cleared or half-typed
 * box commits nothing (so it never becomes 0 behind the person's back) and
 * returns to the last good value on blur.
 */
export function NumberField({ label, value, onChange, className, id, min, max }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Input
      id={id} aria-label={label} type="text" inputMode="decimal" className={className}
      min={min} max={max}
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = parseNumber(e.target.value)
        if (n !== null) onChange(n)
      }}
      onBlur={() => setDraft(null)}
    />
  )
}

interface ListFieldProps<T extends Scalar> {
  label: string
  value: readonly T[]
  /** One entry's text to its value; NaN (for numbers) marks it invalid. */
  parse: (text: string) => T
  onChange: (value: T[]) => void
  placeholder?: string
  className?: string
}

/** A comma-separated list that is parsed when the person leaves the box, not on each keystroke; an invalid entry leaves the stored list alone. */
export function ListField<T extends Scalar>({ label, value, parse, onChange, placeholder, className }: ListFieldProps<T>) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Input
      aria-label={label} className={className} placeholder={placeholder}
      value={draft ?? value.join(", ")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) {
          const items = draft.split(",").map((s) => s.trim()).filter(Boolean).map(parse)
          if (!items.some((item) => typeof item === "number" && Number.isNaN(item))) onChange(items)
        }
        setDraft(null)
      }}
    />
  )
}

interface OptionalNumberFieldProps {
  label: string
  value: number | undefined
  onChange: (value: number | undefined) => void
  placeholder?: string
  className?: string
}

/** A number that may be left empty (an open bound): an empty box means "no limit"; text that is not a number commits nothing. */
export function OptionalNumberField({ label, value, onChange, placeholder, className }: OptionalNumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Input
      aria-label={label} type="text" inputMode="decimal" className={className} placeholder={placeholder}
      value={draft ?? (value === undefined ? "" : String(value))}
      onChange={(e) => {
        setDraft(e.target.value)
        if (e.target.value.trim() === "") onChange(undefined)
        else {
          const n = parseNumber(e.target.value)
          if (n !== null) onChange(n)
        }
      }}
      onBlur={() => setDraft(null)}
    />
  )
}
