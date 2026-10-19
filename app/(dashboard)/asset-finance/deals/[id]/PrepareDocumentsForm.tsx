"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { formatIsoDate } from "@/lib/asset-finance/format"

/**
 * Prepares (or re-prepares) the deal's documents from a chosen contract start
 * date: the loan starts on it and the agreement's schedule is solved from it
 * (POST /api/asset-finance/deals/[id]/signing). Defaults to today (SAST); the
 * picker offers today to `latest` (today + MAX_PLANNED_START_DAYS), the
 * window the server enforces. A lease with its rentals in advance starts on
 * its first due date (`fixedStart`): the date is shown, not chosen, and is the
 * one sent.
 */
export function PrepareDocumentsForm(props: { dealId: string; today: string; latest: string; again: boolean; fixedStart?: string }) {
  const router = useRouter()
  const [chosenStart, setPlannedStartDate] = useState(props.today)
  const plannedStartDate = props.fixedStart ?? chosenStart
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
      {props.fixedStart ? (
        <div className="space-y-1.5">
          <p className="text-xs text-[var(--cf-text-secondary)]">Contract start date</p>
          <p className="text-sm font-semibold text-[var(--cf-text)]">{formatIsoDate(props.fixedStart)}</p>
          <p className="text-xs text-[var(--cf-text-muted)]">Rentals are paid in advance: the lease starts on its first due date.</p>
        </div>
      ) : (
        <TextField id="plannedStartDate" label="Contract start date" type="date" required min={props.today} max={props.latest} value={plannedStartDate} onChange={setPlannedStartDate} />
      )}
      <Button size="sm" variant="outline" onClick={run} disabled={busy || plannedStartDate === ""}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Rendering…" : props.again ? "Prepare documents again" : "Prepare documents"}
      </Button>
      {error && (
        <div className="basis-full">
          <FormError message={error} />
        </div>
      )}
    </div>
  )
}
