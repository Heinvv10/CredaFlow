"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

/** Record a theft reported to SAPS (POST …/telematics/theft-reports): the THEFT purpose holds 30 days from today. */
export function TheftReportForm({ loanId, today, renews }: { loanId: string; today: string; renews?: { id: string; sapsCaseNumber: string } }) {
  const router = useRouter()
  const [caseNumber, setCaseNumber] = useState(renews?.sapsCaseNumber ?? "")
  const [reportedOn, setReportedOn] = useState(today)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    const result = await sendJson(`/api/asset-finance/loans/${loanId}/telematics/theft-reports`, "POST", {
      sapsCaseNumber: caseNumber, reportedOn, renewsReportId: renews?.id ?? null,
    })
    setBusy(false)
    if (!result.ok) return setError(result.error)
    router.refresh()
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <TextField id="saps-case" label="SAPS case number" required value={caseNumber} onChange={setCaseNumber} />
        <TextField id="saps-reported-on" label="Reported to SAPS on" type="date" required max={today} value={reportedOn} onChange={setReportedOn} />
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {renews ? "Renew for 30 days" : "Record theft report"}
        </Button>
      </div>
      <p className="text-xs text-[var(--cf-text-muted)]">e.g. CAS 123/10/2026. The position and trail are shown for 30 days from today; renew with the same case after that.</p>
      <FormError message={error} />
    </div>
  )
}
