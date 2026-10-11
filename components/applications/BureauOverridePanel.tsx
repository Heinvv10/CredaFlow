"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

interface Props {
  applicationId: string
}

const MIN_REASON_LENGTH = 10

export function BureauOverridePanel({ applicationId }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/applications/${applicationId}/bureau-override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })
      if (res.ok) {
        router.refresh()
        return
      }
      const body = await res.json() as { error?: string }
      setError(body.error ?? "Failed to record override")
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-lg border border-[rgba(217,154,58,0.32)] bg-[rgba(217,154,58,0.08)] p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--cf-warning)]" />
        <div className="flex-1">
          <p className="font-medium text-[var(--cf-warning)]">Bureau check required — disbursement blocked</p>
          <p className="mt-1 text-sm text-[var(--cf-text-secondary)]">
            NCA s.81 requires a current credit assessment before funds can move. This application has no current bureau check on file. Document an override with an alternative affordability rationale (verified bank-statement scrape, internal repayment history, etc.) to proceed.
          </p>
          {!open ? (
            <Button className="mt-3" variant="outline" onClick={() => setOpen(true)}>
              Document bureau override
            </Button>
          ) : (
            <>
              <label htmlFor="bureau-override-reason" className="mt-3 block text-sm font-medium text-[var(--cf-text)]">
                Motivating reason for override <span className="text-[var(--cf-danger)]">*</span>
              </label>
              <Textarea
                id="bureau-override-reason"
                className="mt-1.5"
                aria-label="Bureau override reason"
                placeholder={`Motivating reason for override (min ${MIN_REASON_LENGTH} chars)...`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
              />
              {error && (
                <p className="mt-2 rounded border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] px-3 py-1.5 text-sm text-[var(--cf-danger)]">{error}</p>
              )}
              <div className="mt-3 flex gap-2">
                <Button onClick={submit} disabled={reason.trim().length < MIN_REASON_LENGTH || submitting}>
                  <CheckCircle className="h-4 w-4" />
                  {submitting ? "Recording..." : "Confirm Override"}
                </Button>
                <Button variant="outline" onClick={() => { setOpen(false); setError(null) }} disabled={submitting}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
