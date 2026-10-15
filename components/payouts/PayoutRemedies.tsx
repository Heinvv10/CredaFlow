"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { PayoutView } from "@/lib/payouts/view"
import { postAction } from "./post-action"

const OVER = new Set(["FAILED", "RETURNED", "CANCELLED"])

/**
 * Retry a failed/returned payout, or reverse a disbursement whose money never
 * arrived. Each needs a second LOAN_ADMIN to decide (the server says who may).
 */
export function PayoutRemedies({ view }: { view: PayoutView }) {
  const router = useRouter()
  const latest = view.attempts[0]
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const loanOpen = view.loanStatus === "ACTIVE" || view.loanStatus === "DEFAULTED"
  const openReversal = view.reversal?.status === "REQUESTED" ? view.reversal : null
  const canRemedy = loanOpen && OVER.has(latest.status) && !openReversal

  async function act(body: Record<string, unknown>) {
    setBusy(true)
    const out = await postAction(`/api/loans/${view.loanId}/payout`, body)
    setMessage(out.message)
    if (out.ok) {
      setText("")
      router.refresh()
    }
    setBusy(false)
  }

  if (!canRemedy && latest.status !== "AWAITING_APPROVAL" && !openReversal) return null
  return (
    <div className="space-y-2 border-t border-[var(--cf-border-subtle)] pt-3">
      {latest.status === "AWAITING_APPROVAL" && (
        <p className="text-sm text-[var(--cf-text)]">Retry #{latest.attempt} to ••••{latest.accountTail} awaits a second LOAN_ADMIN (not the requester or the disburser).</p>
      )}
      {openReversal && (
        <p className="text-sm text-[var(--cf-text)]">Reversal requested: {openReversal.reason}. A second LOAN_ADMIN (not the requester or the disburser) decides.</p>
      )}
      {canRemedy && (
        <p className="text-sm text-[var(--cf-text)]">
          This payout did not reach the borrower. Retry it to the current verified account (needs a fresh passing AVS), or reverse the disbursement and cancel the loan.
        </p>
      )}
      <Textarea
        placeholder={canRemedy ? "Reason (required to reverse)" : "Decision note (required to reject or to decide a reversal)"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
      />
      <div className="flex flex-wrap gap-2">
        {canRemedy && (
          <>
            <Button size="sm" disabled={busy} onClick={() => act({ action: "request_retry" })}>Retry payout</Button>
            <Button size="sm" variant="outline" disabled={busy || text.trim().length < 10} onClick={() => act({ action: "request_reversal", reason: text })}>Reverse disbursement</Button>
          </>
        )}
        {latest.status === "AWAITING_APPROVAL" && (
          <>
            <Button size="sm" disabled={busy} onClick={() => act({ action: "decide_retry", payoutId: latest.id, approve: true, note: text })}>Approve retry</Button>
            <Button size="sm" variant="outline" disabled={busy || text.trim().length < 5} onClick={() => act({ action: "decide_retry", payoutId: latest.id, approve: false, note: text })}>Reject retry</Button>
          </>
        )}
        {openReversal && (
          <>
            <Button size="sm" disabled={busy || text.trim().length < 5} onClick={() => act({ action: "decide_reversal", reversalId: openReversal.id, approve: true, note: text })}>Approve reversal</Button>
            <Button size="sm" variant="outline" disabled={busy || text.trim().length < 5} onClick={() => act({ action: "decide_reversal", reversalId: openReversal.id, approve: false, note: text })}>Reject reversal</Button>
          </>
        )}
      </div>
      {message && <p className="text-sm text-[var(--cf-text-secondary)]" role="status">{message}</p>}
    </div>
  )
}
