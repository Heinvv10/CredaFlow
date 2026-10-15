"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"

/** Suspend or reactivate a lender (OPERATOR_ADMIN). A reason is required and audited. */
export function LenderStatusControl({ tenantId, status }: { tenantId: string; status: "ACTIVE" | "SUSPENDED" | "PROVISIONING" }) {
  const router = useRouter()
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (status === "PROVISIONING") return null
  const next = status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"

  async function submit() {
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/operator/lenders/${tenantId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next, reason }),
    }).catch(() => null)
    setBusy(false)
    if (res?.ok) {
      setReason("")
      router.refresh()
    } else {
      setError(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "The change failed")
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle className="text-base">{next === "SUSPENDED" ? "Suspend lender" : "Reactivate lender"}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm text-[var(--cf-text-secondary)]">
        <p>
          {next === "SUSPENDED"
            ? "Suspending stops every staff member of this lender signing in and ends their open sessions. Borrower data is untouched."
            : "Reactivating lets this lender's staff sign in again."}
        </p>
        <label htmlFor="lender-status-reason" className="block font-medium">Reason (recorded in the lender&apos;s audit log)</label>
        <Textarea id="lender-status-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        <Button variant={next === "SUSPENDED" ? "destructive" : "default"} disabled={busy || !reason.trim()} onClick={submit}>
          {busy ? "Saving…" : next === "SUSPENDED" ? "Suspend lender" : "Reactivate lender"}
        </Button>
        {error ? <p role="alert" className="text-[var(--cf-danger)]">{error}</p> : null}
      </CardContent>
    </Card>
  )
}
