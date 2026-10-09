"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatZAR } from "@/lib/loan-calculator"
import { ChargesBreakdown } from "@/components/portal/ChargesBreakdown"

export interface LoanOption {
  id: string
  reference: string
  outstandingPrincipal: number
  nextInstallment: number | null
  settlementAmount: number
  paymentDefault: number
  /** default charges included in the amounts above */
  chargeLines: Array<{ label: string; amount: number }>
}

interface Props {
  loans: LoanOption[]
}

function centsToRands(cents: number): string {
  return (cents / 100).toFixed(2)
}

export function StitchPaymentForm({ loans }: Props) {
  const router = useRouter()

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
          setError(
            `The amount exceeds today’s settlement amount of ${formatZAR(json.maxAmountCents)}.`,
          )
          return
        }
        // Never surface the raw API/provider error body to the client — a
        // misconfigured Stitch integration returns 5xx bodies that name env
        // vars (STITCH_CLIENT_ID etc.). Show a generic, actionable message.
        setError(
          "Online payment is temporarily unavailable. Please try again later, or use the manual payment option below.",
        )
        return
      }

      router.push(json.url)
    } catch {
      setError("An unexpected error occurred. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  if (loans.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-6 mb-5">
        <p className="text-gray-500 text-sm">No active loans found.</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-100 shadow-sm p-6 mb-5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-4">
        Pay Online — Instant EFT via Stitch
      </p>

      {loans.length > 1 && (
        <div className="mb-4">
          <label htmlFor="loan-select" className="block text-sm font-medium text-gray-700 mb-1">
            Select Loan
          </label>
          <select
            id="loan-select"
            value={selectedId}
            onChange={(e) => handleLoanChange(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
          >
            {loans.map((l) => (
              <option key={l.id} value={l.id}>
                {l.reference} — {formatZAR(l.settlementAmount)} settlement
              </option>
            ))}
          </select>
        </div>
      )}

      {selectedLoan && (
        <div className="mb-4 text-sm text-gray-600 flex flex-wrap gap-4">
          <span>
            Current settlement:{" "}
            <strong className="text-gray-900">
              {formatZAR(selectedLoan.settlementAmount)}
            </strong>
          </span>
          {selectedLoan.nextInstallment !== null && (
            <span>
              Next installment:{" "}
              <strong className="text-gray-900">
                {formatZAR(selectedLoan.nextInstallment)}
              </strong>
            </span>
          )}
          <ChargesBreakdown lines={selectedLoan.chargeLines} className="w-full" />
        </div>
      )}

      <div className="mb-5">
        <label htmlFor="amount-input" className="block text-sm font-medium text-gray-700 mb-1">
          Amount (ZAR)
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
        {loading ? "Initiating payment…" : "Pay with Stitch"}
      </button>

      <p className="text-[11px] text-gray-400 mt-3 text-center">
        You will be redirected to Stitch&apos;s secure payment portal to complete your EFT.
      </p>
    </form>
  )
}
