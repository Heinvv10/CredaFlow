import Link from "next/link"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { formatDate, formatZAR } from "@/lib/utils"
import type { ReviewQueue } from "@/lib/collections-engine/review"
import { ReviewActions } from "./ReviewActions"

/**
 * The engine's review items with their resolve actions. `showLoan` links each
 * item to its loan (the tenant-wide list on the batch page).
 */
export function ReviewList({ queue, canManage, showLoan }: { queue: ReviewQueue; canManage: boolean; showLoan?: boolean }) {
  const loanLink = (loanId: string) => showLoan
    ? <Link href={`/loans/${loanId}`} className="ml-2 text-xs text-[var(--cf-brand)] hover:underline">Open loan</Link>
    : null
  const empty = queue.instructions.length + queue.results.length + queue.mandates.length === 0
  if (empty) return showLoan ? <p className="text-sm text-[var(--cf-text-muted)]">Nothing waiting for review</p> : null
  return (
    <div className="space-y-3">
      {queue.instructions.map((i) => (
        <InfoStrip key={i.id} variant="warning">
          <div>
            Debit {i.instructionRef} of {formatZAR(i.amountCents)} for {formatDate(i.actionDate)}{i.status === "REJECTED" ? " was rejected by the provider" : ""}: {i.statusReason ?? "fate unknown"}
            {loanLink(i.loanId)}
            {canManage && <ReviewActions kind="INSTRUCTION" id={i.id} actions={i.status === "REJECTED" ? ["ACKNOWLEDGE"] : ["MARK_SUBMITTED", "RELEASE"]} />}
          </div>
        </InfoStrip>
      ))}
      {queue.results.map((r) => (
        <InfoStrip key={r.id} variant="warning">
          <div>
            {r.outcome.toLowerCase()} result of {formatDate(r.resolvedAt)}: {r.reviewReason}
            {loanLink(r.loanId)}
            {canManage && <ReviewActions kind="RESULT" id={r.id} actions={["ACKNOWLEDGE"]} unbookedPayment={r.outcome === "PAID" && !r.paymentId} />}
          </div>
        </InfoStrip>
      ))}
      {queue.mandates.map((m) => (
        <InfoStrip key={m.id} variant="warning">
          <div>
            Mandate ({m.status.toLowerCase().replace(/_/g, " ")}): {m.reviewReason}
            {loanLink(m.loanId)}
            {canManage && m.status === "CREATED" && <ReviewActions kind="MANDATE" id={m.id} actions={["RETRY"]} />}
            {canManage && m.status !== "CREATED" && <ReviewActions kind="MANDATE" id={m.id} actions={["ACKNOWLEDGE"]} />}
          </div>
        </InfoStrip>
      ))}
    </div>
  )
}
