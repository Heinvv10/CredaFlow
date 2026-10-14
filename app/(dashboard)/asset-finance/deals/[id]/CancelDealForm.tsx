"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

/**
 * Cancels a deal that is not booked (POST /api/asset-finance/deals/[id]/cancel):
 * its unreleased payout and its application are cancelled and the asset is
 * released. The reason (at least 10 characters) is recorded and audited.
 */
export function CancelDealForm(props: { dealId: string }) {
  const router = useRouter()
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    const result = await sendJson(`/api/asset-finance/deals/${props.dealId}/cancel`, "POST", { reason })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <TextField id="cancelReason" label="Why is the deal cancelled?" required value={reason} onChange={setReason} />
      <Button size="sm" variant="outline" onClick={run} disabled={busy || reason.trim().length < 10}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Cancelling…" : "Cancel deal"}
      </Button>
      <FormError message={error} />
    </div>
  )
}
