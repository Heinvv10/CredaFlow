"use client"

import { useState } from "react"
import { Loader2, MapPin } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"
import { formatDateTime } from "@/lib/utils"
import { SimulatedChip } from "./SimulatedChip"

type Answer = { position: { latitude: number; longitude: number; accuracyM: number | null; occurredAt: string; simulated: boolean } } | { none: true }

/**
 * "Show last known position" (SLICE5.md part B, POPIA). The page never carries
 * a coordinate: pressing the button asks the server, which logs the view first.
 * Rendered only for view_asset_position. Text only: no map tile, no third-party link.
 * `refusal` is the server's reason the reveal would be refused now
 * (lib/telematics/position-purpose.ts): shown instead of the button.
 */
export function LastKnownPosition({ loanId, context, refusal = null }: { loanId: string; context: "DEFAULT" | "RECOVERY" | "LEGAL_MATTER"; refusal?: string | null }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answer, setAnswer] = useState<Answer | null>(null)

  const reveal = async () => {
    setBusy(true)
    setError(null)
    const result = await sendJson(`/api/asset-finance/loans/${loanId}/telematics/position`, "POST", { context })
    setBusy(false)
    if (!result.ok) return setError(result.error)
    setAnswer(result.body as Answer)
  }

  if (refusal) {
    return <p className="text-xs text-[var(--cf-text-muted)]" data-testid="last-known-position-refused">{`Last known position: ${refusal}.`}</p>
  }
  return (
    <div className="space-y-2" data-testid="last-known-position">
      <Button size="sm" variant="outline" onClick={reveal} disabled={busy}>
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <MapPin className="mr-1.5 h-4 w-4" />}
        Show last known position
      </Button>
      <p className="text-xs text-[var(--cf-text-muted)]">Every view is logged with your name and the time.</p>
      <FormError message={error} />
      {answer && ("none" in answer ? (
        <p className="text-sm text-[var(--cf-text-secondary)]">No position from this loan&apos;s tenure within the retention period.</p>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--cf-text)]">
          <span className="font-mono">{`${answer.position.latitude.toFixed(6)}, ${answer.position.longitude.toFixed(6)}`}</span>
          {answer.position.accuracyM !== null && <span className="text-[var(--cf-text-muted)]">{`± ${answer.position.accuracyM} m`}</span>}
          <span className="text-[var(--cf-text-secondary)]">{`at ${formatDateTime(answer.position.occurredAt)}`}</span>
          {answer.position.simulated && <SimulatedChip />}
        </p>
      ))}
    </div>
  )
}
