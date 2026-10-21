"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"

/**
 * Publish or discard a DRAFT guide. Publish is offered only to a guide manager
 * who did not load it (the API and CHECK ValuationGuide_four_eyes enforce it
 * again); the uploader may discard.
 */
export function GuideActions({ guideId, canPublish }: { guideId: string; canPublish: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState<"publish" | "discard" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const act = async (action: "publish" | "discard") => {
    setBusy(action)
    setError(null)
    const result = await sendJson(`/api/asset-finance/valuation-guides/${guideId}/${action}`, "POST", {})
    setBusy(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <FormError message={error} />
      <div className="flex gap-2">
        {canPublish && (
          <Button size="sm" onClick={() => act("publish")} disabled={busy !== null}>
            {busy === "publish" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Publish
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => act("discard")} disabled={busy !== null}>
          {busy === "discard" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Discard
        </Button>
      </div>
    </div>
  )
}
