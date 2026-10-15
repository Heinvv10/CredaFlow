"use client"

import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError } from "@/components/asset-finance/register-form-controls"
import { useLegalAction } from "./legal-matter-client"
import { costDecisionSubmission, type CostDecision } from "./recovery-cost-adapter"

/** Approve or reject a pending cost (POST .../costs/[costId]/decide); the decider is not the recorder. */
export function CostDecisionButtons({ recoveryId, costId }: { recoveryId: string; costId: string }) {
  const { busy, error, run } = useLegalAction()
  const decide = (decision: CostDecision) => {
    const call = costDecisionSubmission(recoveryId, costId, decision)
    return run(call.url, call.body)
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => decide("APPROVED")}>
          {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Approve cost
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("REJECTED")}>Reject cost</Button>
      </div>
      <FormError message={error} />
    </div>
  )
}
