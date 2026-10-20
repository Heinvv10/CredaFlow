"use client"

import { formatDateTime } from "@/lib/utils"

/** A set-password link, shown once to the staff member who issued it to pass on (nothing is emailed). */
export function OneTimeLink({ url, expiresAt }: { url: string; expiresAt: string }) {
  return (
    <div role="status" className="space-y-1 rounded-md border border-[var(--cf-warning)] bg-[var(--cf-surface-soft)] p-3 text-xs">
      <p className="font-semibold text-[var(--cf-text)]">One-time set-password link (shown once; valid until {formatDateTime(expiresAt)})</p>
      <p className="break-all font-mono text-[var(--cf-text-secondary)]">{url}</p>
      <p className="text-[var(--cf-text-muted)]">Give it to the dealer user yourself. Anyone holding it can set the password, so do not paste it into a shared channel.</p>
    </div>
  )
}
