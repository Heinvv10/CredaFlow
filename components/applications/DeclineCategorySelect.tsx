"use client"

import { DECLINE_CATEGORIES, DECLINE_CATEGORY_LABELS } from "@/lib/applications/decline-category"

/**
 * Required decline category. The first option is blank on purpose: a
 * <select> with no empty option silently submits option[0], and a decline
 * category picked by default would silently misrecord the decline.
 */
export function DeclineCategorySelect({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <label className="w-full text-sm text-[var(--cf-text-secondary)]">
      Decline category (required)
      <select
        aria-label="Decline category"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="mt-1 w-full rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] px-2 py-1.5 text-sm text-[var(--cf-text)] outline-none focus:ring-1 focus:ring-[var(--cf-brand)]"
      >
        <option value="">Choose a category…</option>
        {DECLINE_CATEGORIES.map((c) => (
          <option key={c} value={c}>{DECLINE_CATEGORY_LABELS[c]}</option>
        ))}
      </select>
    </label>
  )
}
