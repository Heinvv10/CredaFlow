"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

/** Creates a payable run to a month end already passed; a different user approves it. */
export function CreateRunForm({ dealerId, defaultPeriodEnd }: { dealerId: string; defaultPeriodEnd: string }) {
  const router = useRouter()
  const [periodEnd, setPeriodEnd] = useState(defaultPeriodEnd)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    setSaving(true)
    setError(null)
    const result = await sendJson(`/api/asset-finance/dealers/${dealerId}/runs`, "POST", { periodEnd })
    setSaving(false)
    if (!result.ok) return setError(result.error)
    router.push(`/asset-finance/dealer-runs/${(result.body as { id: string }).id}`)
  }
  return (
    <div className="space-y-3 rounded-md border border-[var(--cf-border-subtle)] p-4">
      <h3 className="text-sm font-semibold text-[var(--cf-text)]">New payable run</h3>
      <p className="text-xs text-[var(--cf-text-muted)]">
        Takes every unpaid line due by the month end. A clawback is paid with its commission; a commission clawed back after
        the month end waits for the run that takes the clawback.
      </p>
      <FormError message={error} />
      <div className="max-w-xs">
        <TextField id="run-period-end" label="Period end (a month end)" type="date" required value={periodEnd} onChange={setPeriodEnd} />
      </div>
      <Button size="sm" onClick={submit} disabled={saving}>
        {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        Create run
      </Button>
    </div>
  )
}
