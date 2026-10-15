"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatZAR } from "@/lib/loan-calculator"
import { ChargesBreakdown } from "@/components/portal/ChargesBreakdown"
import { useT } from "@/lib/i18n/client"

export interface LoanOption {
  id: string
  reference: string
  outstandingPrincipal: number
  nextInstallment: number | null
  settlementAmount: number
  paymentDefault: number
  /** default charges included in the amounts above */
  chargeLines: Array<{ label: string; amount: number }>
  /** An operating or full-maintenance lease: the figure is the rentals outstanding, not a settlement. */
  lease?: boolean
}

interface Props {
  loans: LoanOption[]
}

function centsToRands(cents: number): string {
  return (cents / 100).toFixed(2)
}

export function StitchPaymentForm({ loans }: Props) {
  const router = useRouter()
  const t = useT("portalPayment")
  const labels = useT("portalLabels")

  const [selectedId, setSelectedId] = useState(loans[0]?.id ?? "")
  const [amount, setAmount] = useState(() => {
    const first = loans[0]
    if (!first) return ""
    return centsToRands(first.paymentDefault)
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedLoan = loans.find((l) => l.id === selectedId)

  function handleLoanChange(loanId: string) {
    setSelectedId(loanId)
    const loan = loans.find((l) => l.id === loanId)
    if (loan) {
      setAmount(centsToRands(loan.paymentDefault))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await fetch("/api/portal/payment/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanId: selectedId, amount: parseFloat(amount) }),
      })

      const json = (await res.json()) as {
        url?: string
        error?: string
        maxAmountCents?: number
      }

      if (!res.ok || !json.url) {
        if (
          res.status === 422
          && typeof json.maxAmountCents === "number"
        ) {
          setError(t(selectedLoan?.lease ? "exceedsRentals" : "exceedsSettlement", { amount: formatZAR(json.maxAmountCents) }))
          return
        }
        // Never surface the raw API/provider error body to the client — a
        // misconfigured Stitch integration returns 5xx bodies that name env
        // vars (STITCH_CLIENT_ID etc.). Show a generic, actionable message.
        setError(t("onlineUnavailable"))
        return
      }

      router.push(json.url)
    } catch {
      setError(t("unexpectedError"))
    } finally {
      setLoading(false)
    }
  }

  if (loans.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-6 mb-5">
        <p className="text-gray-500 text-sm">{t("noActiveLoans")}</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-100 shadow-sm p-6 mb-5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-4">
        {t("payOnline")}
      </p>

      {loans.length > 1 && (
        <div className="mb-4">
          <label htmlFor="loan-select" className="block text-sm font-medium text-gray-700 mb-1">
            {t("selectLoan")}
          </label>
          <select
            id="loan-select"
            value={selectedId}
            onChange={(e) => handleLoanChange(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
          >
            {loans.map((l) => (
              <option key={l.id} value={l.id}>
                {t(l.lease ? "loanOptionLease" : "loanOption", { reference: l.reference, amount: formatZAR(l.settlementAmount) })}
              </option>
            ))}
          </select>
        </div>
      )}

      {selectedLoan && (
        <div className="mb-4 text-sm text-gray-600 flex flex-wrap gap-4">
          <span>
            {t(selectedLoan.lease ? "rentalsOutstanding" : "currentSettlement")}{" "}
            <strong className="text-gray-900">
              {formatZAR(selectedLoan.settlementAmount)}
            </strong>
          </span>
          {selectedLoan.nextInstallment !== null && (
            <span>
              {t("nextInstallment")}{" "}
              <strong className="text-gray-900">
                {formatZAR(selectedLoan.nextInstallment)}
              </strong>
            </span>
          )}
          <ChargesBreakdown lines={selectedLoan.chargeLines} className="w-full" prefix={labels("chargesIncludes")} />
        </div>
      )}

      <div className="mb-5">
        <label htmlFor="amount-input" className="block text-sm font-medium text-gray-700 mb-1">
          {t("amountZar")}
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm select-none">
            R
          </span>
          <input
            id="amount-input"
            type="number"
            min="10"
            step="0.01"
            max={centsToRands(selectedLoan?.settlementAmount ?? 0)}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
          />
        </div>
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-3 rounded-lg font-semibold text-white text-sm transition-opacity disabled:opacity-60"
        style={{ backgroundColor: "#4F46E5" }}
      >
        {loading ? t("initiating") : t("payWithStitch")}
      </button>

      <p className="text-[11px] text-gray-400 mt-3 text-center">
        {t("redirectNote")}
      </p>
    </form>
  )
}
