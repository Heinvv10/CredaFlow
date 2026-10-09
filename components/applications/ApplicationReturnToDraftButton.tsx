"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { PencilLine } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

// Step 2 of the application wizard is Loan Parameters — the amount and term.
// Landing there directly is the point of this button: the officer already
// knows what they want to change, so the wizard's client-selection step is
// just an obstacle between them and the field.
const WIZARD_LOAN_PARAMS_STEP = 2

export function ApplicationReturnToDraftButton({
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
      form.set("action", "return_to_draft")
      form.set("reason", reason.trim())
      const response = await fetch(`/api/applications/${applicationId}/decide`, {
        method: "POST",
        body: form,
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        setError(body.error ?? "Failed to return application to draft")
        return
      }
      // The amount lives in the wizard, not on this page. Refreshing here left
      // the officer on a case file with no visible way to change the figure
      // they just reopened the application to change.
      router.push(
        `/applications/new?id=${applicationId}&step=${WIZARD_LOAN_PARAMS_STEP}`,
      )
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => setOpen(true)}
      >
        <PencilLine className="h-4 w-4" />
        Amend loan amount
      </Button>
    )
  }

  return (
    <div className="w-full space-y-3 rounded-lg border border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] p-3">
      <p className="text-sm text-[var(--cf-text-secondary)]">
        Offering a different amount means re-quoting. Give an audit reason and
        this same application returns to draft, opening the wizard so you can
        change the amount, term or product and submit it for review again.
      </p>
      <p className="text-sm text-[var(--cf-text-secondary)]">
        After reapproval, prepare a fresh PASQ and credit agreement together
        for the client to review and sign in one sitting. Returning to draft
        clears the current review, bureau generation, PASQ, compliance checks,
        credit-life election, and any agreement evidence.
      </p>
      <Textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason for amending, e.g. reduced to R1 000 on risk — client agreed (minimum 10 characters)"
        rows={2}
      />
      {error && (
        <p className="text-xs text-[var(--cf-danger)]">{error}</p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          onClick={submit}
          disabled={reason.trim().length < 10 || submitting}
        >
          <PencilLine className="h-4 w-4" />
          {submitting ? "Opening editor..." : "Confirm and edit amount"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
