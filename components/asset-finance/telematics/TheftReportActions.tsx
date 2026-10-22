"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

/**
 * A theft report's two later steps (lib/telematics/theft-reports.ts): a second person confirms it (THEFT holds only
 * then), and anyone with the permission ends it early with a reason (the asset found).
 */
export function TheftReportActions({ loanId, reportId, canConfirm, canEnd }: { loanId: string; reportId: string; canConfirm: boolean; canEnd: boolean }) {
  const router = useRouter()
  const [ending, setEnding] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const base = `/api/asset-finance/loans/${loanId}/telematics/theft-reports/${reportId}`
  const run = async (path: string, body: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    const result = await sendJson(`${base}/${path}`, "POST", body)
    setBusy(false)
    if (!result.ok) return setError(result.error)
    setEnding(false)
    router.refresh()
  }
  if (!canConfirm && !canEnd) return null
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        {canConfirm && (
          <Button size="sm" onClick={() => run("confirm", {})} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Confirm the report
          </Button>
        )}
        {canEnd && !ending && <Button size="sm" variant="outline" onClick={() => setEnding(true)} disabled={busy}>End the report…</Button>}
      </div>
      {ending && (
        <div className="flex flex-wrap items-end gap-2">
          <TextField id={`theft-end-${reportId}`} label="Why does it end? (e.g. the asset was found)" required value={reason} onChange={setReason} />
          <Button size="sm" variant="destructive" onClick={() => run("end", { reason })} disabled={busy}>End it</Button>
          <Button size="sm" variant="outline" onClick={() => setEnding(false)} disabled={busy}>Keep it</Button>
        </div>
      )}
      <FormError message={error} />
    </div>
  )
}
