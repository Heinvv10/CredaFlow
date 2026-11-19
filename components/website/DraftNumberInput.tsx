"use client"

import { useState, type InputHTMLAttributes } from "react"

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "min" | "max" | "onChange"> & {
  value: number
  min: number
  max: number
  /** Receives a number within [min, max]. */
  onCommit: (value: number) => void
}

/**
 * A number field that keeps what the visitor types. While they type, an
 * in-range figure is committed as it stands and anything else is left alone;
 * on blur or Enter the figure is clamped into range (an empty or invalid field
 * goes back to the current value). Binding a number input straight to a
 * clamped value instead rewrites the field on every key: the first digit of
 * "1500" is clamped up to the minimum and the rest is appended to that.
 */
export function DraftNumberInput({ id, value, min, max, step, onCommit, onBlur, onKeyDown, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null)

  function settle(raw: string) {
    const n = Number(raw)
    if (raw.trim() !== "" && Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)))
    setDraft(null)
  }

  return (
    // Attributes in the order the inline inputs this replaced rendered them,
    // so the server HTML (pinned in app/(website)/site/za-pinned.test.tsx) is
    // unchanged.
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft ?? value}
      {...rest}
      onChange={(event) => {
        const raw = event.target.value
        setDraft(raw)
        const n = Number(raw)
        if (raw.trim() !== "" && n >= min && n <= max) onCommit(n)
      }}
      onBlur={(event) => {
        settle(event.target.value)
        onBlur?.(event)
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") settle(event.currentTarget.value)
        onKeyDown?.(event)
      }}
    />
  )
}
