"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, Banknote, CheckCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { accountTypeLabel } from "@/lib/validation/client-wizard"
import { formatZAR } from "@/lib/utils"

interface Props {
  applicationId: string
  repaymentMethod: "EFT" | "DEBIT_ORDER" | null
  principalCents: number
  /** Cash actually advanced — equals principal in DEFERRED mode, or principal
   *  minus the initiation fee in UPFRONT mode. This is what staff must
   *  transfer to the consumer. */
  disbursementCents: number
  clientName: string
  clientBankDetails: {
    bankName: string | null
    bankAccountNumber: string | null
    bankBranchCode: string | null
    accountType: string | null
  }
}

/**
 * Turns the API's machine-readable evidence reason into the next action. The
 * generic message alone is a dead end: several distinct causes share it, and
 * one of them (a statement that could not be machine-read) looks identical on
 * screen to a statement that is fine, because staff can mark it verified by
 * hand after opening it themselves.
 */
export const EVIDENCE_HINTS: Record<string, string> = {
  bank_details_incomplete:
    "The client's bank name, account number, branch code and account type must all be set on the client record.",
  verified_bank_statement_missing:
    "No verified bank statement is on file for this client, or the one on file failed its validation check. Upload a current statement and verify it.",
  verified_bank_statement_integrity_missing:
    "The stored bank statement file is missing or its bytes no longer match what was verified. Re-upload the statement and verify it again.",
  verified_bank_statement_mismatch:
    "The verified bank statement on file is not for the payout account above.",
}

/**
 * Which leg of the payout tuple the statement failed, from the API's
 * `bankingEvidenceField`. The reason code alone said "could not be machine-read,
 * OR does not match" for every cause at once, so staff were sent to re-upload an
 * unlocked PDF when the real problem was one wrong digit on the client record —
 * or when there was no problem at all.
 */
export const EVIDENCE_FIELD_HINTS: Record<string, string> = {
  extraction_empty:
    "Nothing could be read off the statement at all. If the PDF is password-protected it is never machine-read — re-upload an unlocked copy and re-run extraction.",
  accountNumber:
    "The account number on the statement is not the account number above. Check the client record against the statement.",
  bankName:
    "The bank on the statement is not the bank above. Check the client record against the statement.",
  accountType:
    "The statement shows a different account type to the one on the client record.",
}

function evidenceHint(reason: string | undefined, field?: string): string {
  if (!reason) return ""
  // An unmapped reason still beats silence — staff can quote the code.
  const base = EVIDENCE_HINTS[reason] ?? `Reason code: ${reason}.`
  const detail = field ? EVIDENCE_FIELD_HINTS[field] ?? `Field: ${field}.` : ""
  return [base, detail].filter(Boolean).join(" ")
}

export function DisburseForm({ applicationId, repaymentMethod, principalCents, disbursementCents, clientName, clientBankDetails }: Props) {
  const feeDeducted = disbursementCents < principalCents
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const bank = clientBankDetails.bankName ?? ""
  const accountNo = clientBankDetails.bankAccountNumber ?? ""
  const branchCode = clientBankDetails.bankBranchCode ?? ""
  const accountType = clientBankDetails.accountType ?? ""
  const [bankRef, setBankRef] = useState("")
  const [confirm, setConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clientBankMissing = !clientBankDetails.bankName || !clientBankDetails.bankAccountNumber

  async function submit() {
    if (!bank || !accountNo) { setError("Bank and account number required"); return }
    if (!confirm) { setError("Please confirm the disbursement details are correct"); return }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/applications/${applicationId}/disburse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankRef,
        }),
      })
      if (!res.ok) {
        const d = await res.json() as {
          error?: string
          bankingEvidence?: string
          bankingEvidenceField?: string
          debitMandateEvidence?: string
        }
        // The API distinguishes several banking failures that share one
        // sentence. Without the specific reason staff see "must match a
        // verified bank statement" while looking at a statement marked
        // verified, with nothing to act on.
        const detail = evidenceHint(
          d.bankingEvidence ?? d.debitMandateEvidence,
          d.bankingEvidenceField,
        )
        setError([d.error ?? "Disbursement failed", detail].filter(Boolean).join(" "))
        return
      }
      router.refresh()
    } catch {
      setError("Request failed")
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Banknote className="h-4 w-4" />
        Disburse Loan
      </Button>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[rgba(63,191,127,0.32)] bg-[var(--cf-bg-panel)]">
      <div className="flex items-center gap-2 border-b border-[rgba(63,191,127,0.26)] bg-[rgba(63,191,127,0.08)] px-5 py-3">
        <Banknote className="h-4 w-4 text-[var(--cf-success)]" />
        <span className="text-sm font-semibold text-[var(--cf-text)]">Disburse Loan - {formatZAR(disbursementCents)} to {clientName}</span>
      </div>

      <div className="space-y-4 p-5">
        <div className="flex items-start gap-2 rounded-lg border border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--cf-warning)]" />
          <p className="text-xs font-medium text-[var(--cf-warning)]">
            This action is irreversible. The loan will be created and repayment schedule generated immediately.
          </p>
        </div>

        <div className="rounded-lg border border-[rgba(63,191,127,0.26)] bg-[rgba(63,191,127,0.07)] px-4 py-3">
          <p className="text-sm font-semibold text-[var(--cf-success)]">Client bank details are locked for disbursement</p>
          <p className="mt-1 text-xs leading-5 text-[var(--cf-text-secondary)]">
            {repaymentMethod === "EFT"
              ? "These are the recorded payout details. Before funds move, the disbursement gate will match them to an intact verified bank statement. Repayment is set to EFT, so no debit mandate is required."
              : "These details match the customer’s verified bank statement and signed debit mandate. Change them only through a new customer-authorised mandate."}
          </p>
        </div>

        {clientBankMissing && (
          <p className="rounded border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] px-3 py-2 text-xs text-[var(--cf-danger)]">
            {repaymentMethod === "EFT"
              ? "Client bank details are incomplete. Verify the payout banking before disbursement."
              : "Client bank details are incomplete. The customer must complete and sign a new debit mandate before disbursement."}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank *">
            <input value={bank} className={fieldClass} readOnly />
          </Field>
          <Field label="Account Type">
            <input value={accountTypeLabel(accountType)} className={fieldClass} readOnly />
          </Field>
          <Field label="Account Number *">
            <input value={accountNo} className={`${fieldClass} font-mono`} readOnly />
          </Field>
          <Field label="Branch Code">
            <input value={branchCode} className={`${fieldClass} font-mono`} readOnly />
          </Field>
          <Field label="Payment Reference (optional)" className="col-span-2">
            <input value={bankRef} onChange={e => setBankRef(e.target.value)} className={fieldClass} placeholder="e.g. DISB-20260404-001" />
          </Field>
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[rgba(63,191,127,0.28)] bg-[rgba(63,191,127,0.08)] px-4 py-3">
          <input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--cf-success)]" />
          <div>
            <p className="text-sm font-semibold text-[var(--cf-success)]">I confirm the disbursement details are correct</p>
            <p className="mt-0.5 text-xs text-[var(--cf-text-secondary)]">
              Disbursing {formatZAR(disbursementCents)} to <strong>{clientName}</strong> at {bank || "..."} - Account {accountNo || "..."}
            </p>
            {feeDeducted && (
              <p className="mt-0.5 text-xs text-[var(--cf-text-secondary)]">
                (Principal {formatZAR(principalCents)} less the initiation fee {formatZAR(principalCents - disbursementCents)}, deducted from the advance per the consumer&apos;s election.)
              </p>
            )}
          </div>
          {confirm && <CheckCircle className="ml-auto mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--cf-success)]" />}
        </label>

        {error && <p className="rounded border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] px-3 py-2 text-xs text-[var(--cf-danger)]">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={() => { setOpen(false); setError(null) }}>Cancel</Button>
          <Button onClick={submit} disabled={loading || !confirm || !bank || !accountNo || clientBankMissing}>
            <Banknote className="h-4 w-4" />
            {loading ? "Disbursing..." : `Confirm - Disburse ${formatZAR(disbursementCents)}`}
          </Button>
        </div>
      </div>
    </div>
  )
}

const fieldClass = "w-full rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] px-2.5 py-2 text-sm text-[var(--cf-text)] outline-none focus:ring-1 focus:ring-[var(--cf-brand)]"

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-muted)]">{label}</label>
      {children}
    </div>
  )
}
