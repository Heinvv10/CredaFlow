"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"

/**
 * Approve or reject the PENDING NCA → NON_NCA override on the deal's
 * application (decide_asset_finance). The API refuses the person who asked
 * for it (four-eyes, CHECK NcaRegimeOverride_four_eyes).
 */
export function OverrideDecision({ overrideId }: { overrideId: string }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<"APPROVE" | "REJECT" | null>(null)

  const decide = async (decision: "APPROVE" | "REJECT") => {
    setSaving(decision)
    setError(null)
    const result = await sendJson(`/api/asset-finance/nca-overrides/${overrideId}/decide`, "POST", { decision, note })
    setSaving(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="space-y-2 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-3">
      <FormError message={error} />
      <Label htmlFor="override-note" className="text-xs text-[var(--cf-text-secondary)]">
        What did you check before agreeing the deal is outside the NCA? *
      </Label>
      <Textarea id="override-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => decide("APPROVE")} disabled={saving !== null}>
          {saving === "APPROVE" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Approve NON_NCA
        </Button>
        <Button size="sm" variant="outline" onClick={() => decide("REJECT")} disabled={saving !== null}>
          {saving === "REJECT" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Reject
        </Button>
      </div>
    </div>
  )
}
