"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export function ApplicationReturnToReviewButton({
  applicationId,
}: {
  applicationId: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const form = new FormData()
      form.set("action", "return_to_review")
      form.set("reason", reason)
      const response = await fetch(`/api/applications/${applicationId}/decide`, {
        method: "POST",
        body: form,
      })
      if (!response.ok) {
        const body = await response.json() as { error?: string }
        setError(body.error ?? "Failed to return application to review")
        return
      }
      router.refresh()
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <RotateCcw className="h-4 w-4" />
        Return to review
      </Button>
    )
  }

  return (
    <div className="w-full space-y-2 rounded-lg border border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] p-3">
      <p className="text-sm text-[var(--cf-text-secondary)]">
        This archives the approval and invalidates the current PASQ acknowledgement and agreement/signature. Reassessment, approval, document generation, and signing must be completed again.
      </p>
      <Textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason for reassessment (required)"
        rows={2}
      />
      {error && <p className="text-xs text-[var(--cf-danger)]">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={reason.trim().length < 10 || submitting}>
          <RotateCcw className="h-4 w-4" />
          {submitting ? "Returning..." : "Confirm return"}
        </Button>
        <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
