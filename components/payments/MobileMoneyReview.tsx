"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { formatDate, formatZAR } from "@/lib/utils"
import { toast } from "@/lib/toast"

export interface MobileMoneyReviewItem {
  id: string
  status: "UNMATCHED" | "NEEDS_REVIEW"
  transId: string | null
  billRef: string
  amount: number
  /** What the provider reported paid, where it differs from the STK push's amount. */
  reportedAmount: number | null
  reviewReason: string | null
  transactedAt: string | null
  createdAt: string
  simulated: boolean
  msisdnLast4: string | null
  loan: { id: string; reference: string } | null
}

type Mode = { id: string; kind: "allocate" | "reject" } | null

/**
 * M-Pesa payments the ingest could not book: no loan carried the account
 * number the payer typed, or the money path refused it. Allocating books the
 * receipt on the loan named here; rejecting records why it is not ours.
 */
export function MobileMoneyReview({ items, canAct }: { items: MobileMoneyReviewItem[]; canAct: boolean }) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>(null)
  const [loanReference, setLoanReference] = useState("")
  const [reason, setReason] = useState("")
  const [amountConfirmed, setAmountConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  function open(item: MobileMoneyReviewItem, kind: "allocate" | "reject") {
    setMode({ id: item.id, kind })
    setLoanReference(item.loan?.reference ?? item.billRef)
    setReason("")
    setAmountConfirmed(false)
    setError("")
  }

  async function submit(item: MobileMoneyReviewItem) {
    if (!mode) return
    const body = mode.kind === "reject"
      ? { action: "reject", reason }
      : { action: "allocate", loanReference, ...(item.reportedAmount !== null ? { confirmedAmount: item.reportedAmount } : {}) }
    setBusy(true)
    setError("")
    try {
      const res = await fetch(`/api/payments/mobile-money/${item.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(data.error ?? "Could not update the M-Pesa payment.")
        return
      }
      toast.success(mode.kind === "reject" ? "M-Pesa payment rejected" : `M-Pesa payment of ${formatZAR(item.reportedAmount ?? item.amount)} booked`)
      setMode(null)
      router.refresh()
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100">
        <p className="text-sm font-semibold text-gray-900">Waiting for a person ({items.length})</p>
        <p className="text-xs text-gray-500">Money M-Pesa reports that was not booked automatically. Nothing here is on a loan yet.</p>
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-500">No M-Pesa payments are waiting.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs uppercase text-gray-500">
              <th className="px-4 py-2">Received</th>
              <th className="px-4 py-2">M-Pesa code</th>
              <th className="px-4 py-2">Account typed</th>
              <th className="px-4 py-2">Why</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-gray-50 align-top">
                <td className="px-4 py-2">{formatDate(item.transactedAt ?? item.createdAt)}</td>
                <td className="px-4 py-2 font-mono">
                  {item.transId}{item.simulated && <span className="ml-1 text-[10px] font-semibold text-amber-700">SIMULATED</span>}
                </td>
                <td className="px-4 py-2 font-mono">
                  {item.loan ? <Link href={`/loans/${item.loan.id}`} className="hover:underline">{item.loan.reference}</Link> : item.billRef || "—"}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">{item.status === "UNMATCHED" ? "No loan has this account number" : item.reviewReason}</td>
                <td className="px-4 py-2 text-right font-medium">
                  {formatZAR(item.reportedAmount ?? item.amount)}
                  {item.reportedAmount !== null && (
                    <span className="block text-[11px] font-normal text-amber-700">reported paid; {formatZAR(item.amount)} was requested</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {!canAct ? (
                    <span className="text-xs text-gray-400">Allocated by staff who record loan payments</span>
                  ) : mode?.id === item.id ? (
                    <div className="space-y-2 text-left">
                      {mode.kind === "allocate" ? (
                        <>
                          <label className="block text-xs text-gray-600">Loan reference
                            <input value={loanReference} onChange={(e) => setLoanReference(e.target.value)}
                              className="mt-1 block w-48 rounded border border-gray-200 px-2 py-1 font-mono text-sm" />
                          </label>
                          {item.reportedAmount !== null && (
                            <label className="flex max-w-xs items-start gap-2 whitespace-normal text-xs text-gray-700">
                              <input type="checkbox" checked={amountConfirmed} onChange={(e) => setAmountConfirmed(e.target.checked)} className="mt-0.5" />
                              I confirmed with M-Pesa that {formatZAR(item.reportedAmount)} was paid (not the {formatZAR(item.amount)} requested). Book {formatZAR(item.reportedAmount)}.
                            </label>
                          )}
                        </>
                      ) : (
                        <label className="block text-xs text-gray-600">Why is it rejected?
                          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                            className="mt-1 block w-64 rounded border border-gray-200 px-2 py-1 text-sm" />
                        </label>
                      )}
                      {error && <p role="alert" className="max-w-xs whitespace-normal text-xs text-red-600">{error}</p>}
                      <div className="flex gap-2">
                        <button type="button" onClick={() => submit(item)}
                          disabled={busy || (mode.kind === "allocate" && item.reportedAmount !== null && !amountConfirmed)}
                          className="rounded bg-gray-900 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
                          {mode.kind === "allocate" ? "Confirm allocation" : "Confirm rejection"}
                        </button>
                        <button type="button" disabled={busy} onClick={() => setMode(null)} className="text-xs text-gray-600">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => open(item, "allocate")}
                        className="rounded border border-green-300 px-2 py-1 text-xs font-semibold text-green-700 hover:bg-green-50">Allocate</button>
                      <button type="button" onClick={() => open(item, "reject")}
                        className="rounded border border-red-300 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">Reject</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
