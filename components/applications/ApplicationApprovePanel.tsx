"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { DeclineCategorySelect } from "./DeclineCategorySelect"

interface BureauGate {
  reason: string | null
  bureauMissing: boolean
}

interface KycError {
  kycStatus: string
  missingDocs: string[]
}

interface Props {
  applicationId: string
  canApprove: boolean
}

type Phase = "idle" | "override" | "declining" | "refreshing"
type RepaymentMethod = "EFT" | "DEBIT_ORDER"

type DecisionErrorBody = {
  error?: string
  requiresOverride?: boolean
  bureauMissing?: boolean
  kycStatus?: string
  missingDocs?: string[]
  idCopyAwaitingVerification?: boolean
  affordabilitySnapshot?: string
  bureauOverrideValidation?: "reason_too_short"
}

function parseDecisionErrorBody(value: unknown): DecisionErrorBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const missingDocs = Array.isArray(record.missingDocs)
    && record.missingDocs.every((entry) => typeof entry === "string")
    ? record.missingDocs
    : undefined
  return {
    error: typeof record.error === "string" ? record.error : undefined,
    requiresOverride: typeof record.requiresOverride === "boolean"
      ? record.requiresOverride
      : undefined,
    bureauMissing: typeof record.bureauMissing === "boolean"
      ? record.bureauMissing
      : undefined,
    kycStatus: typeof record.kycStatus === "string"
      ? record.kycStatus
      : undefined,
    missingDocs,
    idCopyAwaitingVerification: record.idCopyAwaitingVerification === true ? true : undefined,
    affordabilitySnapshot: typeof record.affordabilitySnapshot === "string"
      ? record.affordabilitySnapshot
      : undefined,
    bureauOverrideValidation:
      record.bureauOverrideValidation === "reason_too_short"
        ? "reason_too_short"
        : undefined,
  }
}

export function ApplicationApprovePanel({ applicationId, canApprove }: Props) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>("idle")
  const [bureauGate, setBureauGate] = useState<BureauGate | null>(null)
  const [kycError, setKycError] = useState<KycError | null>(null)
  const [overrideReason, setOverrideReason] = useState("")
  const [declineReason, setDeclineReason] = useState("")
  const [declineCategory, setDeclineCategory] = useState("")
  const [repaymentMethod, setRepaymentMethod] = useState<RepaymentMethod | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [submissionEvidenceError, setSubmissionEvidenceError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!canApprove) return null

  async function post(fields: Record<string, string>) {
    setSubmitting(true)
    setErrorMsg(null)
    setKycError(null)
    setSubmissionEvidenceError(null)
    try {
      const fd = new FormData()
      for (const [k, v] of Object.entries(fields)) fd.append(k, v)
      const res = await fetch(`/api/applications/${applicationId}/decide`, { method: "POST", body: fd })
      if (res.ok) {
        setPhase("refreshing")
        setBureauGate(null)
        setErrorMsg(null)
        setOverrideReason("")
        router.refresh()
        return
      }
      const body = parseDecisionErrorBody(await res.json())
      if (res.status === 422 && body.requiresOverride === true) {
        setBureauGate({
          reason: body.error ?? null,
          bureauMissing: body.bureauMissing === true,
        })
        setPhase("override")
      } else if (res.status === 422 && body.idCopyAwaitingVerification) {
        // The ID copy is listed as missing, but the remedy is verifying the
        // copy already on file: say that, not "KYC incomplete".
        setErrorMsg(body.error ?? "The client's ID copy must be verified before approval.")
        setPhase("idle")
        setBureauGate(null)
      } else if (res.status === 422 && body.missingDocs) {
        setKycError({ kycStatus: body.kycStatus ?? "PENDING", missingDocs: body.missingDocs ?? [] })
        setPhase("idle")
        setBureauGate(null)
      } else if (
        res.status === 422 &&
        (body.affordabilitySnapshot === "submission_missing" ||
          body.affordabilitySnapshot === "submission_changed")
      ) {
        setSubmissionEvidenceError(body.error ?? "Submission affordability evidence must be recaptured.")
        setPhase("idle")
        setBureauGate(null)
      } else if (res.status === 422 && body.requiresOverride === false) {
        setErrorMsg(body.error ?? "Approval is blocked and cannot be overridden.")
        setPhase("idle")
        setBureauGate(null)
      } else if (body.bureauOverrideValidation === "reason_too_short") {
        setErrorMsg(body.error ?? "Enter a longer bureau override reason.")
      } else {
        setErrorMsg(body.error ?? "An error occurred")
        if (phase === "override") {
          setPhase("idle")
          setBureauGate(null)
        }
      }
    } catch {
      setErrorMsg("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (phase === "override" && bureauGate) {
    return (
      <div className="rounded-lg border border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--cf-warning)]" />
          <div className="flex-1">
            <p role="status" className="font-medium text-[var(--cf-warning)]">
              {bureauGate.bureauMissing
                ? "Bureau enquiry missing — override required"
                : "Approval blocked — override required"}
            </p>
            {bureauGate.bureauMissing ? (
              <p className="mt-1 text-sm text-[var(--cf-text-secondary)]">
                No successful credit bureau check on file. NCA s.81 requires a credit assessment before approval. Document an alternative affordability rationale (e.g. verified bank-statement scrape, internal repayment history) to proceed.
              </p>
            ) : (
              bureauGate.reason && (
                <p className="mt-1 text-sm text-[var(--cf-text-secondary)]">{bureauGate.reason}</p>
              )
            )}
            {errorMsg && (
              <p
                role="alert"
                className="mt-3 rounded border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] px-3 py-1.5 text-sm text-[var(--cf-danger)]"
              >
                {errorMsg}
              </p>
            )}
            <Textarea className="mt-3" placeholder="Motivating reason for override (required)..." value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} rows={3} />
            <div className="mt-3 flex gap-2">
              <Button
                onClick={() => post({
                  action: "approve",
                  repaymentMethod: repaymentMethod ?? "",
                  bureauOverrideReason: overrideReason,
                })}
                disabled={!repaymentMethod || !overrideReason.trim() || submitting}
              >
                <CheckCircle className="h-4 w-4" />Confirm Override
              </Button>
              <Button variant="outline" onClick={() => { setPhase("idle"); setBureauGate(null); setErrorMsg(null) }} disabled={submitting}>Cancel</Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (phase === "refreshing") {
    return (
      <p role="status" className="text-sm text-[var(--cf-text-secondary)]">
        Application updated. Refreshing...
      </p>
    )
  }

  if (phase === "declining") {
    return (
      <div className="flex flex-col items-end gap-2">
        {errorMsg && (
          <p
            role="alert"
            className="w-full rounded border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] px-3 py-1.5 text-sm text-[var(--cf-danger)]"
          >
            {errorMsg}
          </p>
        )}
        <DeclineCategorySelect value={declineCategory} onChange={setDeclineCategory} disabled={submitting} />
        <Textarea placeholder="Decline reason (optional)..." value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} rows={2} className="w-full" />
        <div className="flex gap-2">
          <Button variant="destructive" onClick={() => post({ action: "decline", declineCategory, ...(declineReason ? { reason: declineReason } : {}) })} disabled={submitting || !declineCategory}>
            <XCircle className="h-4 w-4" />Confirm Decline
          </Button>
          <Button variant="outline" onClick={() => setPhase("idle")} disabled={submitting}>Cancel</Button>
        </div>
      </div>
    )
  }

  if (submissionEvidenceError) {
    return (
      <div className="rounded-lg border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] p-4">
        <p role="alert" className="text-sm text-[var(--cf-danger)]">{submissionEvidenceError}</p>
        <Button
          className="mt-3"
          variant="outline"
          onClick={() => post({
            action: "return_to_draft",
            reason: "Submission affordability evidence must be recaptured",
          })}
          disabled={submitting}
        >
          Return to Draft and Recapture
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {kycError && (
        <p role="alert" className="w-full rounded border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] px-3 py-1.5 text-sm text-[var(--cf-danger)]">
          KYC incomplete ({kycError.kycStatus}) - missing: {kycError.missingDocs.map((d) => d.replace(/_/g, " ")).join(", ")}
        </p>
      )}
      {errorMsg && (
        <p role="alert" className="w-full rounded border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] px-3 py-1.5 text-sm text-[var(--cf-danger)]">{errorMsg}</p>
      )}
      <fieldset className="w-full rounded-lg border border-[var(--cf-border-subtle)] p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-muted)]">
          Repayment method
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--cf-border-subtle)] p-3">
            <input
              type="radio"
              name="repaymentMethod"
              value="EFT"
              checked={repaymentMethod === "EFT"}
              onChange={() => setRepaymentMethod("EFT")}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-semibold text-[var(--cf-text)]">EFT payment</span>
              <span className="block text-xs text-[var(--cf-text-secondary)]">Client pays by electronic transfer. No debit mandate is required.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--cf-border-subtle)] p-3">
            <input
              type="radio"
              name="repaymentMethod"
              value="DEBIT_ORDER"
              checked={repaymentMethod === "DEBIT_ORDER"}
              onChange={() => setRepaymentMethod("DEBIT_ORDER")}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-semibold text-[var(--cf-text)]">Debit order</span>
              <span className="block text-xs text-[var(--cf-text-secondary)]">Client must sign the debit mandate before payout.</span>
            </span>
          </label>
        </div>
      </fieldset>
      <div className="flex gap-2">
        <Button
          onClick={() => post({
            action: "approve",
            repaymentMethod: repaymentMethod ?? "",
          })}
          disabled={!repaymentMethod || submitting}
        >
          <CheckCircle className="h-4 w-4" />Approve
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            setErrorMsg(null)
            setPhase("declining")
          }}
          disabled={submitting}
        >
          <XCircle className="h-4 w-4" />Decline
        </Button>
      </div>
    </div>
  )
}
