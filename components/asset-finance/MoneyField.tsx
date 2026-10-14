"use client"

import { useState } from "react"
import { TextField } from "@/components/asset-finance/register-form-controls"
import { formatMoneyInput } from "@/lib/asset-finance/format"

/**
 * A rand amount field: shows "R 25,000,000.00" while not being edited and
 * the plain number typed while it has focus. The value kept and sent is
 * always the typed text, so formatting can never change an amount.
 */
export function MoneyField(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  allowNegative?: boolean
  error?: string
}) {
  const [editing, setEditing] = useState(false)
  return (
    <div onFocus={() => setEditing(true)} onBlur={() => setEditing(false)}>
      <TextField
        id={props.id}
        label={props.label}
        required={props.required}
        inputMode="decimal"
        value={editing ? props.value : formatMoneyInput(props.value, props.allowNegative)}
        onChange={props.onChange}
        error={props.error}
      />
    </div>
  )
}
