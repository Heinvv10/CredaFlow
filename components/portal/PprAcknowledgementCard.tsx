"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, CheckCircle, FileText, Info } from "lucide-react"

interface Props {
  policyId: string
  /** Link to the stored disclosure document, or null if none is on file. */
  disclosureUrl: string | null
  issued: boolean
  acknowledgedAt: string | null
}

export function PprAcknowledgementCard({ policyId, disclosureUrl, issued, acknowledgedAt }: Props) {
  const router = useRouter()
  const [opened, setOpened] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function acknowledge() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/portal/insurance/policies/${policyId}/ppr-acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        setError(data.error ?? "Could not record your acknowledgement")
        return
      }
      router.refresh()
    } catch {
      setError("Could not record your acknowledgement. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (acknowledgedAt) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-4">
        <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
        <div>
          <p className="text-sm font-semibold text-green-800">Product disclosure acknowledged</p>
          <p className="mt-0.5 text-xs text-green-700">Recorded {acknowledgedAt}.</p>
          {disclosureUrl && (
            <a
              href={disclosureUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-xs font-semibold text-green-800 underline"
            >
              View the disclosure you acknowledged
            </a>
          )}
        </div>
      </div>
    )
  }

  // Nothing has been issued yet, so there is nothing for the client to confirm.
  if (!issued) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-[var(--cf-brand-soft)]" />
        <div>
          <p className="text-sm font-semibold text-[var(--cf-text)]">Product disclosure not yet issued</p>
          <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">
            Once the Policyholder Protection Rules disclosure for this policy has been issued, you will be able to
            review and acknowledge it here.
          </p>
        </div>
      </div>
    )
  }

  // Issued, but the document is not retrievable here. Offering an
  // "acknowledge" button would record that the client accepted a disclosure
  // they were never shown, so deliberately do not offer one.
  if (!disclosureUrl) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div>
          <p className="text-sm font-semibold text-amber-800">Product disclosure issued — copy not available online</p>
          <p className="mt-0.5 text-xs text-amber-700">
            The disclosure for this policy is not stored against your online record, so it cannot be reviewed or
            acknowledged here. Please contact us for a copy.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-800">Please review your product disclosure</p>
          <p className="mt-0.5 text-xs text-amber-700">
            Open the Policyholder Protection Rules disclosure for this policy, read what is covered, what is excluded
            and how to claim, then confirm that you have reviewed it.
          </p>
          <a
            href={disclosureUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpened(true)}
            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-bold text-white"
          >
            <FileText className="h-4 w-4" />
            Open disclosure
          </a>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-amber-900">
            <input
              type="checkbox"
              // Stable hook for the test that guards "starts disabled until the
              // disclosure is opened". Without it the assertion has to match the
              // first checkbox in the document, which silently retargets if
              // another checkbox is ever added above this one.
              data-testid="ppr-confirm-checkbox"
              checked={confirmed}
              disabled={!opened}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#4F46E5]"
            />
            <span>
              I have opened and reviewed the product disclosure for this policy, including what is excluded and how to
              claim.
            </span>
          </label>
          <button
            type="button"
            disabled={!opened || !confirmed || submitting}
            onClick={acknowledge}
            className="mt-3 rounded-lg border border-amber-700 px-4 py-2 text-sm font-bold text-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Recording..." : "Acknowledge disclosure"}
          </button>
          {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  )
}
