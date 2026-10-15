"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { PayoutView, RecoveryView } from "@/lib/payouts/view"
import { formatZAR } from "@/lib/utils"
import { postAction } from "./post-action"

const day = (iso: string) => new Date(iso).toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg" })

/**
 * What an approved disbursement reversal leaves for staff: cancelling the
 * debit order by hand (no mandate register on this build) until someone
 * acknowledges it, and any money a provider paid out on the loan afterwards
 * (a recovery case: record it recovered, or escalate it).
 */
export function ReversedLoanTasks({ view, canAct }: { view: PayoutView; canAct: boolean }) {
  const reversal = view.reversal?.status === "APPROVED" ? view.reversal : null
  if (!reversal && view.recoveries.length === 0) return null
  return (
    <div className="mb-4 space-y-3">
      {reversal && !reversal.debitOrderCancelAckAt && <DebitOrderTask loanId={view.loanId} reversalId={reversal.id} canAct={canAct} />}
      {reversal?.debitOrderCancelAckAt && (
        <p className="text-xs text-[var(--cf-text-muted)]">Debit order cancellation acknowledged on {day(reversal.debitOrderCancelAckAt)}.</p>
      )}
      {view.recoveries.map((r) => <RecoveryCase key={r.id} loanId={view.loanId} recovery={r} canAct={canAct} />)}
    </div>
  )
}

function useAct(loanId: string) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  async function act(body: Record<string, unknown>) {
    setBusy(true)
    const out = await postAction(`/api/loans/${loanId}/payout`, body)
    setMessage(out.message)
    if (out.ok) router.refresh()
    setBusy(false)
  }
  return { busy, message, act }
}

function DebitOrderTask({ loanId, reversalId, canAct }: { loanId: string; reversalId: string; canAct: boolean }) {
  const { busy, message, act } = useAct(loanId)
  const [note, setNote] = useState("")
  return (
    <InfoStrip variant="warning">
      <p className="font-medium">Task: cancel the debit order by hand.</p>
      <p className="mt-1">
        This build keeps no debit-mandate register, so any debit order for this loan is still live at the bank or collection provider. Cancel it there, then acknowledge it here.
      </p>
      {canAct && (
        <div className="mt-2 space-y-2">
          <Textarea placeholder="Who cancelled it, with whom, and the reference (required)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          <Button size="sm" disabled={busy || note.trim().length < 5} onClick={() => act({ action: "ack_debit_order", reversalId, note })}>Debit order cancelled</Button>
          {message && <p className="text-sm" role="status">{message}</p>}
        </div>
      )}
    </InfoStrip>
  )
}

function RecoveryCase({ loanId, recovery: r, canAct }: { loanId: string; recovery: RecoveryView; canAct: boolean }) {
  const { busy, message, act } = useAct(loanId)
  const [note, setNote] = useState("")
  const [reference, setReference] = useState("")
  const [backOn, setBackOn] = useState("")
  if (r.status === "RECOVERED") {
    return (
      <p className="text-xs text-[var(--cf-text-muted)]">
        {formatZAR(r.amountCents)} paid out after the reversal (attempt {r.attempt}) was recovered on {r.recoveredAt ? day(r.recoveredAt) : "—"}.
      </p>
    )
  }
  return (
    <InfoStrip variant="danger">
      <p className="font-medium">
        Funds paid out on a reversed loan: {formatZAR(r.amountCents)} left on {day(r.paidAt)} (attempt {r.attempt}){r.status === "ESCALATED" ? " — escalated" : ""}.
      </p>
      <p className="mt-1">
        The loan stays cancelled. The money sits in payout clearing in the accounting export until it is recovered from the recipient.
        {r.escalationNote ? ` Escalation: ${r.escalationNote}` : ""}
      </p>
      {canAct && (
        <div className="mt-2 space-y-2">
          <p className="text-xs">Acted on by a LOAN_ADMIN who neither made nor approved the payout.</p>
          <Textarea placeholder="What happened (required)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs">
              Date the full amount came back
              <Input type="date" aria-label="Date the funds came back" value={backOn} onChange={(e) => setBackOn(e.target.value)} className="mt-1 w-44" />
            </label>
            <Input placeholder="Bank reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} className="w-56" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || note.trim().length < 5 || !backOn} onClick={() => act({ action: "record_recovery", caseId: r.id, recoveredAt: backOn, note, reference })}>Record recovered funds</Button>
            {r.status === "OPEN" && (
              <Button size="sm" variant="outline" disabled={busy || note.trim().length < 5} onClick={() => act({ action: "escalate_recovery", caseId: r.id, note })}>Escalate</Button>
            )}
          </div>
          {message && <p className="text-sm" role="status">{message}</p>}
        </div>
      )}
    </InfoStrip>
  )
}
