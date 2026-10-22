"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField } from "@/components/asset-finance/register-form-controls"
import { LeaseActionButton } from "./LeaseActionButton"
import { useLeaseAction } from "./lease-action"

/**
 * The four-eyes void of one meter reading (lib/asset-finance/meter-void.ts):
 * ask with a reason, or, while a request waits, approve or reject it. The
 * server refuses the asker deciding their own request.
 */
export function ReadingVoidControls({ loanId, readingId, pending }: {
  loanId: string
  readingId: string
  pending: { id: string; reason: string; requestedBy: string } | null
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const { busy, error, run } = useLeaseAction()
  if (pending) {
    const url = `/api/asset-finance/leases/${loanId}/reading-voids/${pending.id}/decide`
    return (
      <div className="space-y-1 text-xs">
        <p className="text-[var(--cf-warning)]">Void asked by {pending.requestedBy}: “{pending.reason}”</p>
        <div className="flex gap-2">
          <LeaseActionButton url={url} body={{ decision: "APPROVE" }} label="Approve void" busyLabel="Approving…" variant="destructive" />
          <LeaseActionButton url={url} body={{ decision: "REJECT" }} label="Reject" busyLabel="Rejecting…" variant="outline" />
        </div>
      </div>
    )
  }
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Void…</Button>
  return (
    <div className="space-y-2">
      <TextField id={`void-reason-${readingId}`} label="Why is this reading wrong?" required value={reason} onChange={setReason} />
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={busy}
          onClick={async () => { if (await run(`/api/asset-finance/leases/${loanId}/readings/${readingId}/void`, { reason })) setOpen(false) }}>
          {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {busy ? "Asking…" : "Ask a second person to void it"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Keep it</Button>
      </div>
      <FormError message={error} />
    </div>
  )
}
