import { AlertTriangle } from "lucide-react"
import type { PayoutBlock } from "@/lib/applications/pipeline-view"

/**
 * Why this application's last payout attempt was refused.
 *
 * The attempt COUNT is on the badge deliberately. Application
 * clxtest000000000000000002 was refused five times across two days — four of
 * them by the same staff member — and the board drew an ordinary Approved card
 * throughout, so nothing distinguished a fifth failed attempt from a first.
 */
export function PayoutBlockBadge({
  block,
  className = "",
}: {
  block: PayoutBlock
  className?: string
}) {
  const attemptText = block.attempts === 1
    ? "1 attempt"
    : `${block.attempts} attempts`
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border border-[rgba(220,120,90,0.35)] bg-[rgba(220,120,90,0.12)] px-2 py-1 text-[11px] font-medium text-[var(--cf-danger,#e0a08a)] ${className}`}
      title={`Refused at payout — ${block.label}. ${attemptText}, last on ${block.refusedAt.toLocaleString("en-ZA")}.`}
    >
      <AlertTriangle className="h-3 w-3 shrink-0" />
      <span className="truncate">{block.label}</span>
      <span className="shrink-0 opacity-70">· {block.attempts}×</span>
    </span>
  )
}
