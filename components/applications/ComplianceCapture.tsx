"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Props {
  applicationId: string
  recklessDone: boolean
  recklessNote?: string | null
  affordabilityDeclared: boolean
  /** The viewer may confirm the checks (PATCH /api/applications/[id]/compliance: LOAN_ADMIN and above). */
  canConfirm: boolean
}

/**
 * Review-stage NCA checks only. The Pre-Agreement Statement & Quotation is
 * deliberately NOT here: NCA s.92(1) requires the quotation before the
 * agreement is ENTERED INTO, not before the credit decision, so it is issued
 * and acknowledged in the signing ceremony (see AgreementSection). Putting it
 * back here would restore the mid-review halt this was built to remove.
 */
export function ComplianceCapture({
  applicationId,
  recklessDone,
  recklessNote,
  affordabilityDeclared,
  canConfirm,
}: Props) {
  const router = useRouter()
  const [reckless, setReckless] = useState(recklessDone)
  const [declared, setDeclared] = useState(affordabilityDeclared)
  const [note, setNote] = useState(recklessNote ?? "")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(recklessDone && affordabilityDeclared)
  const complianceComplete = saved
  const allDone = reckless && declared

  async function save() {
    if (!allDone) {
      setError("All three compliance checks must be completed before saving.")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/applications/${applicationId}/compliance`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recklessLendingAssessed: reckless,
          recklessLendingNote: note,
          clientAffordabilityDeclared: declared,
        }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: string }
        setError(d.error ?? "Failed")
        return
      }
      setSaved(true)
      router.refresh()
    } catch {
      setError("Request failed")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`overflow-hidden rounded-lg border bg-[var(--cf-bg-panel)] ${complianceComplete ? "border-[rgba(63,191,127,0.32)]" : "border-[rgba(217,154,58,0.32)]"}`}>
      <div className={`flex items-center gap-2 border-b px-5 py-3 ${complianceComplete ? "border-[rgba(63,191,127,0.26)] bg-[rgba(63,191,127,0.08)]" : "border-[rgba(217,154,58,0.26)] bg-[rgba(217,154,58,0.08)]"}`}>
        {complianceComplete ? <CheckCircle className="h-4 w-4 text-[var(--cf-success)]" /> : <AlertTriangle className="h-4 w-4 text-[var(--cf-warning)]" />}
        <span className="text-sm font-semibold text-[var(--cf-text)]">NCA Compliance Checks</span>
        {complianceComplete && <span className="ml-auto flex items-center gap-1 text-xs font-semibold text-[var(--cf-success)]"><ShieldCheck className="h-3.5 w-3.5" />Complete</span>}
      </div>

      <div className="space-y-4 p-5">
        <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={reckless} disabled={!canConfirm} onChange={e => { setReckless(e.target.checked); setSaved(false) }} className="mt-1 h-4 w-4 accent-[var(--cf-brand)] disabled:cursor-not-allowed" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-[var(--cf-text)]">Reckless lending assessment completed</p>
            <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">Affordability has been assessed under NCA Sections 80-81. No reckless lending determination applies.</p>
            {reckless && (
              <textarea
                value={note}
                onChange={e => { setNote(e.target.value); setSaved(false) }}
                placeholder="Assessment notes (optional)"
                rows={2}
                className="mt-2 w-full resize-none rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] px-2.5 py-1.5 text-xs text-[var(--cf-text)] outline-none focus:ring-1 focus:ring-[var(--cf-brand)]"
              />
            )}
          </div>
          {reckless && <CheckCircle className="ml-auto mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--cf-success)]" />}
        </label>
        <div className="border-t border-[var(--cf-border-subtle)]" />
        <CheckRow checked={declared} disabled={!canConfirm} onChange={(value) => { setDeclared(value); setSaved(false) }} title="Client affordability declaration captured" description="The client declared income, expenses, and obligations truthfully and accepted the affordability assessment." />

        {error && <p className="rounded border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] px-3 py-2 text-xs text-[var(--cf-danger)]">{error}</p>}

        <div className="flex items-center justify-end gap-3">
          {!canConfirm && <p className="text-xs text-[var(--cf-text-muted)]">Needs a Loan Admin, Branch Manager or Admin to confirm these checks.</p>}
          <Button onClick={save} disabled={loading || !allDone || !canConfirm}>
            {loading ? "Saving..." : saved ? "Update Assessment Checks" : "Confirm Assessment Checks"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function CheckRow({ checked, disabled, onChange, title, description }: { checked: boolean; disabled: boolean; onChange: (value: boolean) => void; title: string; description: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--cf-brand)] disabled:cursor-not-allowed" />
      <div>
        <p className="text-sm font-semibold text-[var(--cf-text)]">{title}</p>
        <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">{description}</p>
      </div>
      {checked && <CheckCircle className="ml-auto mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--cf-success)]" />}
    </label>
  )
}
