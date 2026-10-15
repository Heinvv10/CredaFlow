"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField } from "@/components/asset-finance/register-form-controls"
import { LeaseActionButton } from "./LeaseActionButton"
import { useLeaseAction } from "./lease-action"

/**
 * The steps open on one maintenance claim (lib/asset-finance/lease-staff-actions.ts
 * claimActions): approve, reject with a reason, or mark an approved claim paid
 * with its payment reference. `url` is .../claims/[claimId].
 */
export function ClaimActions(props: { url: string; approve: boolean; reject: boolean; paid: boolean; hint: string | null }) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState("")
  const [reference, setReference] = useState("")
  const decide = useLeaseAction()
  const pay = useLeaseAction()

  return (
    <div className="space-y-2">
      {props.hint && <p className="text-xs text-[var(--cf-text-muted)]">{props.hint}</p>}
      {props.approve && <LeaseActionButton url={`${props.url}/approve`} label="Approve" busyLabel="Approving…" />}
      {props.reject && !rejecting && (
        <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>Reject</Button>
      )}
      {props.reject && rejecting && (
        <div className="space-y-2">
          <TextField id={`${props.url}-reason`} label="Reason for rejecting" value={reason} onChange={setReason} />
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={decide.busy} onClick={() => decide.run(`${props.url}/reject`, { reason })}>
              {decide.busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {decide.busy ? "Rejecting…" : "Reject claim"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
          </div>
          <FormError message={decide.error} />
        </div>
      )}
      {props.paid && (
        <div className="space-y-2">
          <TextField id={`${props.url}-reference`} label="Payment reference" value={reference} onChange={setReference} />
          <Button size="sm" disabled={pay.busy} onClick={() => pay.run(`${props.url}/paid`, { paymentReference: reference })}>
            {pay.busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {pay.busy ? "Recording…" : "Mark paid"}
          </Button>
          <FormError message={pay.error} />
        </div>
      )}
    </div>
  )
}
