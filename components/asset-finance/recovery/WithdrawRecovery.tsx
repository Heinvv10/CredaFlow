"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError } from "@/components/asset-finance/register-form-controls"
import { AreaField } from "./legal-fields"
import { useLegalAction } from "./legal-matter-client"

/** Withdraw the recovery (POST .../recoveries/[id]/withdraw): the reason is required, 10 to 1000 characters. */
export function WithdrawRecovery({ recoveryId }: { recoveryId: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const { busy, error, setError, run } = useLegalAction()

  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Withdraw recovery</Button>
  const submit = () => {
    if (reason.trim().length < 10) return setError("Give the reason for the withdrawal in at least 10 characters")
    return run(`/api/asset-finance/recoveries/${recoveryId}/withdraw`, { reason: reason.trim() })
  }
  return (
    <div className="w-full space-y-3 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-3">
      <AreaField id="withdrawReason" label="Reason for withdrawing" required value={reason} onChange={setReason} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="destructive" disabled={busy} onClick={submit}>
          {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {busy ? "Withdrawing…" : "Withdraw recovery"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setOpen(false); setError(null) }}>Cancel</Button>
      </div>
      <FormError message={error} />
    </div>
  )
}
