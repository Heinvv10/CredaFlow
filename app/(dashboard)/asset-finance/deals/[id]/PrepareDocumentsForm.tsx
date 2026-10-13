"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

/**
 * Prepares (or re-prepares) the deal's documents from a chosen contract start
 * date: the loan starts on it and the agreement's schedule is solved from it
 * (POST /api/asset-finance/deals/[id]/signing). Defaults to today (SAST); the
 * picker offers today to `latest` (today + MAX_PLANNED_START_DAYS), the
 * window the server enforces.
 */
export function PrepareDocumentsForm(props: { dealId: string; today: string; latest: string; again: boolean }) {
  const router = useRouter()
  const [plannedStartDate, setPlannedStartDate] = useState(props.today)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    const result = await sendJson(`/api/asset-finance/deals/${props.dealId}/signing`, "POST", { plannedStartDate })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <TextField id="plannedStartDate" label="Contract start date" type="date" required min={props.today} max={props.latest} value={plannedStartDate} onChange={setPlannedStartDate} />
      <Button size="sm" variant="outline" onClick={run} disabled={busy || plannedStartDate === ""}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Rendering…" : props.again ? "Prepare documents again" : "Prepare documents"}
      </Button>
      <FormError message={error} />
    </div>
  )
}
