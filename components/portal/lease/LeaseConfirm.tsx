"use client"

// The confirm step before an action a lessee cannot undo.
export function LeaseConfirm({ children, confirmLabel, busy, onConfirm, onCancel }: {
  children: React.ReactNode
  confirmLabel: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div role="alertdialog" aria-label="Confirm" className="space-y-3 rounded-md border border-[var(--cf-warning)] bg-[var(--cf-surface-soft)] p-3 text-sm text-[var(--cf-text)]">
      <div>{children}</div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onConfirm} disabled={busy} className="rounded-md bg-[var(--cf-brand)] px-4 py-2 font-semibold text-[var(--cf-on-brand)] disabled:opacity-50">
          {busy ? "Sending…" : confirmLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-md border border-[var(--cf-border-strong)] px-4 py-2 font-semibold text-[var(--cf-text)] disabled:opacity-50">
          Go back
        </button>
      </div>
    </div>
  )
}
