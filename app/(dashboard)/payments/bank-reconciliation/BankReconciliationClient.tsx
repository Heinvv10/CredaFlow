"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatZAR, formatDate } from "@/lib/utils"
import { confirmMatchAction, ignoreMatchAction, reassignMatchAction } from "./actions"

type LoanRef = {
  id: string
  reference: string
  client: { firstName: string; lastName: string }
}

type Txn = {
  id: string
  postedDate: string
  amountCents: number
  rawReference: string | null
  counterparty: string | null
  matchStatus: string
  matchConfidence: string | null
  matchedLoanId: string | null
  matchedLoan: LoanRef | null
}

function loanLabel(loan: LoanRef): string {
  return `${loan.reference} — ${loan.client.firstName} ${loan.client.lastName}`
}

export function BankReconciliationClient({
  txns,
  candidateLoans,
}: {
  txns: Txn[]
  candidateLoans: LoanRef[]
}) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loanInput, setLoanInput] = useState<Record<string, string>>({})

  const proposed = txns.filter((t) => t.matchStatus === "PROPOSED")
  const unmatched = txns.filter((t) => t.matchStatus === "UNMATCHED")
  const loanByReference = new Map(candidateLoans.map((l) => [l.reference, l]))

  async function handleConfirm(txn: Txn) {
    if (!txn.matchedLoanId) return
    setError(null)
    setBusyId(txn.id)
    try {
      await confirmMatchAction(txn.id, txn.matchedLoanId)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not confirm match")
    } finally {
      setBusyId(null)
    }
  }

  async function handleIgnore(txnId: string) {
    const reason = window.prompt("Reason for ignoring this transaction?")
    if (!reason || !reason.trim()) return
    setError(null)
    setBusyId(txnId)
    try {
      await ignoreMatchAction(txnId, reason.trim())
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not ignore transaction")
    } finally {
      setBusyId(null)
    }
  }

  async function handleAssign(txnId: string) {
    const typed = (loanInput[txnId] ?? "").trim()
    const loan = loanByReference.get(typed)
    if (!loan) {
      setError(`No active/defaulted loan found with reference "${typed}"`)
      return
    }
    setError(null)
    setBusyId(txnId)
    try {
      await reassignMatchAction(txnId, loan.id)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not assign loan")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {/* Proposed matches */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-700">
            Proposed matches — {proposed.length} awaiting review
          </p>
        </div>
        {proposed.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No proposed matches</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-4 py-2 text-left font-semibold text-gray-500 uppercase">Date</th>
                <th className="px-4 py-2 text-left font-semibold text-gray-500 uppercase">Reference</th>
                <th className="px-4 py-2 text-right font-semibold text-gray-500 uppercase">Amount</th>
                <th className="px-4 py-2 text-left font-semibold text-gray-500 uppercase">Matched Loan</th>
                <th className="px-4 py-2 text-left font-semibold text-gray-500 uppercase">Confidence</th>
                <th className="px-4 py-2 text-right font-semibold text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {proposed.map((t) => (
                <tr key={t.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="px-4 py-2 text-gray-500">{formatDate(t.postedDate)}</td>
                  <td className="px-4 py-2 text-gray-500">{t.rawReference ?? t.counterparty ?? "—"}</td>
                  <td className="px-4 py-2 text-right font-medium">{formatZAR(t.amountCents)}</td>
                  <td className="px-4 py-2">
                    {t.matchedLoan ? loanLabel(t.matchedLoan) : t.matchedLoanId ?? "—"}
                  </td>
                  <td className="px-4 py-2">{t.matchConfidence ?? "—"}</td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <button
                      onClick={() => handleConfirm(t)}
                      disabled={busyId === t.id}
                      className="px-3 py-1 rounded-md bg-green-600 text-white font-medium disabled:opacity-50"
                    >
                      {busyId === t.id ? "Confirming…" : "Confirm"}
                    </button>
                    <button
                      onClick={() => handleIgnore(t.id)}
                      disabled={busyId === t.id}
                      className="px-3 py-1 rounded-md border border-gray-300 text-gray-600 font-medium disabled:opacity-50"
                    >
                      Ignore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Unmatched transactions */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-700">
            Unmatched deposits — {unmatched.length} need a loan assigned
          </p>
        </div>
        {unmatched.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No unmatched transactions</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-4 py-2 text-left font-semibold text-gray-500 uppercase">Date</th>
                <th className="px-4 py-2 text-left font-semibold text-gray-500 uppercase">Reference</th>
                <th className="px-4 py-2 text-right font-semibold text-gray-500 uppercase">Amount</th>
                <th className="px-4 py-2 text-left font-semibold text-gray-500 uppercase">Assign to Loan</th>
                <th className="px-4 py-2 text-right font-semibold text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((t) => (
                <tr key={t.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="px-4 py-2 text-gray-500">{formatDate(t.postedDate)}</td>
                  <td className="px-4 py-2 text-gray-500">{t.rawReference ?? t.counterparty ?? "—"}</td>
                  <td className="px-4 py-2 text-right font-medium">{formatZAR(t.amountCents)}</td>
                  <td className="px-4 py-2">
                    <input
                      type="text"
                      list="candidate-loan-references"
                      placeholder="Loan reference…"
                      value={loanInput[t.id] ?? ""}
                      onChange={(e) => setLoanInput((prev) => ({ ...prev, [t.id]: e.target.value }))}
                      className="border border-gray-300 rounded px-2 py-1 text-xs w-48"
                    />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => handleAssign(t.id)}
                      disabled={busyId === t.id}
                      className="px-3 py-1 rounded-md bg-blue-600 text-white font-medium disabled:opacity-50"
                    >
                      {busyId === t.id ? "Assigning…" : "Assign"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <datalist id="candidate-loan-references">
        {candidateLoans.map((l) => (
          <option key={l.id} value={l.reference}>
            {loanLabel(l)}
          </option>
        ))}
      </datalist>
    </div>
  )
}
