"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { CheckCircle, Loader2 } from "lucide-react"
import { useT } from "@/lib/i18n/client"

export interface LoanOption {
  id: string
  reference: string
  outstandingPrincipal: number
  nextInstallment: number | null
  settlementAmount?: number
  paymentDefault?: number
}

interface Props {
  loans: LoanOption[]
}

const PROOF_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"]
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

// LoanOption.nextInstallment is in cents (matches Prisma Int column convention).
// Format it as a rands decimal string for the amount input. Treat 0 the same
// as null/undefined — a zero-due loan should leave the field blank rather
// than pre-fill "0.00" (which the validator rejects anyway).
function nextDueAsRandsStr(loanId: string, loans: LoanOption[]): string {
  const loan = loans.find(l => l.id === loanId)
  const cents = loan?.paymentDefault ?? loan?.nextInstallment
  if (!cents) return ""
  return (cents / 100).toFixed(2)
}

// Resolve the selected loan's reference (Loan.reference) — the token the
// bank-sync reconciler EXACT-matches on. Used to pre-fill the Bank Reference
// field so the client quotes the correct reference by default. Exported for
// unit tests. Returns "" for an unknown loan.
export function refFor(loanId: string, loans: LoanOption[]): string {
  return loans.find(l => l.id === loanId)?.reference ?? ""
}

export function ManualPaymentForm({ loans }: Props) {
  const t = useT("portalPayment")
  const [loanId, setLoanId] = useState(loans[0]?.id ?? "")
  // default to the selected loan's next instalment so the borrower
  // doesn't retype the most common amount. handleLoanChange keeps the
  // field in sync if they switch loans before submitting.
  const [amountStr, setAmountStr] = useState(() => nextDueAsRandsStr(loans[0]?.id ?? "", loans))
  // Pre-fill the Bank Reference with the selected loan's reference so the
  // client quotes the exact reconciler token by default. handleLoanChange
  // keeps it in sync when they switch loans, unless they've customised it.
  const [reference, setReference] = useState(() => refFor(loans[0]?.id ?? "", loans))
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)

  const handleSubmit = async () => {
    const amount = parseFloat(amountStr)
    if (!loanId || isNaN(amount) || amount <= 0) {
      setError(t("errSelectLoan"))
      return
    }
    if (!file) {
      setError(t("errAttachProof"))
      return
    }
    if (!PROOF_MIME_TYPES.includes(file.type)) {
      setError(t("errProofType"))
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setError(t("errProofSize"))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const form = new FormData()
      form.append("loanId", loanId)
      form.append("amount", String(Math.round(amount * 100)))
      if (reference) form.append("reference", reference)
      if (paymentDate) form.append("paymentDate", paymentDate)
      if (notes) form.append("notes", notes)
      form.append("file", file)

      const res = await fetch("/api/portal/payment/manual", {
        method: "POST",
        body: form,
      })
      if (res.ok) {
        setDone(true)
      } else {
        const data = await res.json() as { error?: string }
        setError(data.error ?? t("errSubmission"))
      }
    } catch {
      setError(t("errNetwork"))
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
        <CheckCircle className="h-8 w-8 text-green-600 mx-auto mb-3" />
        <p className="font-semibold text-green-800">{t("notifiedTitle")}</p>
        <p className="text-sm text-green-700 mt-1">
          {t("notifiedBody")}
        </p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-6 space-y-4">
      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{t("notifyTitle")}</p>
      <p className="text-sm text-gray-600">
        {t("notifyBody")}
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">{t("loan")}</label>
          <select
            value={loanId}
            onChange={(e) => {
              const newLoanId = e.target.value
              // Only auto-update the amount if the user hasn't customised it —
              // i.e. the field is empty or still equals the old loan's default.
              // This preserves a typed amount when the borrower switches loans
              // intentionally after deciding how much to pay.
              const oldDefault = nextDueAsRandsStr(loanId, loans)
              if (amountStr === "" || amountStr === oldDefault) {
                setAmountStr(nextDueAsRandsStr(newLoanId, loans))
              }
              // Same guard for the Bank Reference: only re-default it if the
              // user hasn't typed their own reference over the old loan's.
              const oldRef = refFor(loanId, loans)
              if (reference === "" || reference === oldRef) {
                setReference(refFor(newLoanId, loans))
              }
              setLoanId(newLoanId)
            }}
            className="w-full border border-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
          >
            {loans.map((l) => (
              <option key={l.id} value={l.id}>{l.reference}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t("amountPaid")}</label>
            <input
              type="number"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              placeholder="0.00"
              min="0"
              step="0.01"
              className="w-full border border-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t("paymentDate")}</label>
            <input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className="w-full border border-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">{t("bankReference")}</label>
          <input
            type="text"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder={t("bankReferencePlaceholder")}
            className="w-full border border-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">{t("notes")}</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder={t("notesPlaceholder")}
            className="w-full border border-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5] resize-none"
          />
        </div>

        <div>
          <label htmlFor="proof-file" className="block text-xs font-medium text-gray-500 mb-1">
            {t("proofOfPayment")} <span className="text-red-500">*</span>
          </label>
          <input
            id="proof-file"
            type="file"
            required
            accept=".pdf,.jpg,.jpeg,.png"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-[#4F46E5] file:text-white hover:file:bg-[#4338CA]"
          />
          {file && (
            <p className="text-[11px] text-gray-500 mt-1 truncate">{t("selectedFile", { name: file.name })}</p>
          )}
          <p className="text-[11px] text-gray-400 mt-1">{t("fileHint")}</p>
        </div>

        <Button
          onClick={handleSubmit}
          disabled={submitting || !file}
          className="w-full"
          style={{ backgroundColor: "#4F46E5" }}
        >
          {submitting ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{t("submitting")}</>
          ) : (
            t("submitNotification")
          )}
        </Button>
      </div>
    </div>
  )
}
