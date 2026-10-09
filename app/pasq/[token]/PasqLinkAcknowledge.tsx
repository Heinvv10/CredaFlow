"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"

interface Props {
  token: string
}

/**
 * The consumer's acknowledgement control on the one-time link surface.
 *
 * The checkbox is the consumer's own statement that they read the quotation;
 * the server independently requires a logged view of the exact document before
 * it will record anything, so this control cannot manufacture the evidence.
 */
export function PasqLinkAcknowledge({ token }: Props) {
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function acknowledge() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/pasq-link/${token}/acknowledge`, { method: "POST" })
      const data = await res.json().catch(() => null) as { error?: string } | null
      if (res.ok) {
        setDone(true)
        return
      }
      setError(data?.error ?? "The acknowledgement could not be recorded. Please try again.")
    } catch {
      setError("The acknowledgement could not be sent. Check your connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-5 text-emerald-900">
        <p className="text-base font-semibold">Thank you — your quotation is confirmed.</p>
        <p className="mt-1 text-sm">
          Your consultant can now prepare your credit agreement. You may close this page.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>
          I have read this Pre-Agreement Statement &amp; Quotation, including the
          instalment, the total cost of credit and my credit-life choice, and I
          confirm I received it.
        </span>
      </label>

      {error && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}

      <Button onClick={acknowledge} disabled={!confirmed || submitting}>
        {submitting ? "Confirming..." : "Confirm I received this quotation"}
      </Button>

      <p className="text-xs text-neutral-500">
        Confirming does not commit you to the loan. You will still be asked to
        sign the credit agreement separately.
      </p>
    </div>
  )
}
