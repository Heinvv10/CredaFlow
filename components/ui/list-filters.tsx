"use client"

import { ChevronDown, Search, X } from "lucide-react"

/**
 * Shared filter-bar primitives for the staff list surfaces (loans,
 * disbursements, collections, payments, insurance, opportunities). They exist
 * so every list looks and behaves the same; the filtering itself stays in each
 * list, because what "matches" means differs per domain.
 */

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label: string
  className?: string
}

export function SearchInput({ value, onChange, placeholder, label, className }: SearchInputProps) {
  return (
    <div className={`relative ${className ?? ""}`}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--cf-text-muted)]" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-9 w-56 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] pl-9 pr-8 text-sm text-[var(--cf-text-secondary)] outline-none transition-colors placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-border-strong)] focus:ring-2 focus:ring-[rgba(79,70,229,0.22)] sm:w-64"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={`Clear ${label.toLowerCase()}`}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text-secondary)]"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

interface FilterSelectProps {
  value: string
  onChange: (value: string) => void
  label: string
  options: { value: string; label: string }[]
}

/**
 * Options are always rendered with an explicit `value`, and callers derive them
 * from the rows on screen — a select whose bound value matches no option
 * silently displays option[0], which has misled staff in prod before.
 */
export function FilterSelect({ value, onChange, label, options }: FilterSelectProps) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="h-9 appearance-none rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] px-3 pr-8 text-sm text-[var(--cf-text-secondary)] outline-none transition-colors focus:border-[var(--cf-border-strong)] focus:ring-2 focus:ring-[rgba(79,70,229,0.22)]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--cf-text-muted)]" />
    </div>
  )
}

interface FilterSummaryProps {
  matched: number
  total: number
  noun: string
  onClear: () => void
}

/** "12 of 42 loans match · Clear" — shown only while a filter is active. */
export function FilterSummary({ matched, total, noun, onClear }: FilterSummaryProps) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--cf-text-muted)]">
      <span>
        {matched} of {total} {noun} match
      </span>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex items-center gap-1 text-[var(--cf-brand-soft)] hover:underline"
      >
        <X className="h-3 w-3" />
        Clear
      </button>
    </p>
  )
}
