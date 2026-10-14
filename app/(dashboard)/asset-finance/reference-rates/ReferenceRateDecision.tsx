"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"

interface Reach {
  wouldReprice: number
  superseded: boolean
  backdated: boolean
}

function reachText(reach: Reach | undefined): string | null {
  if (!reach) return null
  if (reach.wouldReprice > 0) return `Approved. The repricing run will reprice ${reach.wouldReprice} loan(s) on it.`
  if (reach.superseded) return "Approved, but a later value of this basis already applies: it reprices no loan. The loan admins were alerted."
  if (reach.backdated) return "Approved, but it is dated before the loans' current rates: it reprices no loan. The loan admins were alerted."
  return "Approved. No active loan is linked to this basis yet."
}

/**
 * Approve or reject a PENDING reference rate. Rendered only for a user with
 * decide_asset_finance who did not record it; the API and
 * CHECK ReferenceRate_four_eyes enforce both rules again.
 */
export function ReferenceRateDecision({ rateId }: { rateId: string }) {
  const router = useRouter()
  const [saving, setSaving] = useState<"APPROVE" | "REJECT" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const decide = async (decision: "APPROVE" | "REJECT") => {
    setSaving(decision)
    setError(null)
    const result = await sendJson(`/api/asset-finance/reference-rates/${rateId}/decide`, "POST", { decision })
    setSaving(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const reach = decision === "APPROVE" ? reachText((result.body as { reach?: Reach }).reach) : null
    // An approval's reach is shown until it is read; the refresh would unmount it.
    if (reach) setMessage(reach)
    else router.refresh()
  }

  if (message) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-[var(--cf-text-secondary)]">{message}</p>
        <Button size="sm" variant="outline" onClick={() => router.refresh()}>Done</Button>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <FormError message={error} />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => decide("APPROVE")} disabled={saving !== null}>
          {saving === "APPROVE" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => decide("REJECT")} disabled={saving !== null}>
          {saving === "REJECT" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Reject
        </Button>
      </div>
    </div>
  )
}
