"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "@/lib/toast"

const OUTCOME_TEXT: Record<string, string> = {
  BOOKED: "Booked on the loan.",
  HELD: "Held for reconciliation (default charges).",
  UNMATCHED: "No loan has that reference: waiting below.",
  NEEDS_REVIEW: "Not booked: waiting below for a person.",
  DUPLICATE: "Already received.",
}

/**
 * The demo's paybill payment: what a borrower paying from their phone would
 * send. Rendered only where simulated-mpesa is permitted; the route refuses
 * (404) everywhere else.
 */
export function SimulatePaybillForm() {
  const router = useRouter()
  const [loanReference, setLoanReference] = useState("")
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMessage("")
    try {
      const res = await fetch("/api/payments/mobile-money/simulate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanReference, amount: Number(amount) }),
      })
      const data = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string }
      if (!res.ok || !data.outcome) {
        setMessage(data.error ?? "The simulated payment failed.")
        return
      }
      toast.success("Simulated paybill payment sent", OUTCOME_TEXT[data.outcome] ?? data.outcome)
      setMessage(OUTCOME_TEXT[data.outcome] ?? data.outcome)
      router.refresh()
    } catch {
      setMessage("Network error. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-lg shadow-sm p-5 space-y-3">
      <div>
        <p className="text-sm font-semibold text-gray-900">Simulate paybill payment</p>
        <p className="text-xs text-amber-700">SIMULATED: no money moves. Only offered on a demo or test stack.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-600">Account number (loan reference)
          <input value={loanReference} onChange={(e) => setLoanReference(e.target.value)} required
            className="mt-1 block w-48 rounded border border-gray-200 px-2 py-1 font-mono text-sm" />
        </label>
        <label className="text-xs text-gray-600">Amount (whole)
          <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} required
            className="mt-1 block w-32 rounded border border-gray-200 px-2 py-1 text-sm" />
        </label>
        <button type="submit" disabled={busy}
          className="rounded bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {busy ? "Sending…" : "Send paybill payment"}
        </button>
      </div>
      {message && <p role="status" className="text-xs text-gray-700">{message}</p>}
    </form>
  )
}
