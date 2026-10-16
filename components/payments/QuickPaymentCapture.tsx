"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { DollarSign, CheckCircle, X } from "lucide-react"
import {
  beginPaymentAttempt,
  finishPaymentAttempt,
  PAYMENT_IDEMPOTENCY_HEADER,
  type PaymentAttempt,
} from "@/lib/payments/idempotency"
import { formatZAR } from "@/lib/utils"

interface Props {
  loanId: string
  loanRef: string
  outstanding: number
}

const METHODS = [
  { value: "EFT", label: "EFT" },
  { value: "CASH", label: "Cash" },
  { value: "DEBIT_ORDER", label: "Debit Order" },
  { value: "CARD", label: "Card" },
]

export function QuickPaymentCapture({ loanId, loanRef, outstanding }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState("")
  const [method, setMethod] = useState("EFT")
  const [ref, setRef] = useState("")
  const [notes, setNotes] = useState("")
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attemptRef = useRef<PaymentAttempt | null>(null)

  async function submit() {
    const amountCents = Math.round(parseFloat(amount) * 100)
    if (isNaN(amountCents) || amountCents <= 0) { setError("Enter a valid amount"); return }
    if (amountCents > outstanding) { setError(`Amount exceeds outstanding balance (${formatZAR(outstanding)})`); return }

    const payload = { loanId, amount: amountCents, paymentMethod: method, reference: ref || null, notes: notes || null }
    const idempotencyKey = beginPaymentAttempt(attemptRef, JSON.stringify(payload))
    if (!idempotencyKey) return

    setLoading(true)
    setError(null)
    let completed = false
    try {
      const res = await fetch("/api/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PAYMENT_IDEMPOTENCY_HEADER]: idempotencyKey,
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: string }
        setError(d.error ?? "Failed to capture payment")
        return
      }
      completed = true
      setSuccess(true)
      setTimeout(() => {
        setOpen(false)
        setSuccess(false)
        setAmount("")
        setRef("")
        setNotes("")
        router.refresh()
      }, 1500)
    } catch {
      setError("Request failed")
    } finally {
      finishPaymentAttempt(attemptRef, completed)
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-white"
        style={{ backgroundColor: "#10B981" }}
      >
        <DollarSign className="h-4 w-4" />
        Capture Payment
      </button>
    )
  }

  return (
    <div className="bg-white rounded-lg border border-green-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-green-100 flex items-center justify-between" style={{ background: "#f0fdf4" }}>
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-green-600" />
          <span className="text-sm font-semibold text-green-800">Capture Payment — {loanRef}</span>
        </div>
        <button onClick={() => setOpen(false)} disabled={loading} className="text-gray-400 hover:text-gray-600 disabled:opacity-50">
          <X className="h-4 w-4" />
        </button>
      </div>

      {success ? (
        <div className="px-4 py-6 flex items-center justify-center gap-2 text-green-700">
          <CheckCircle className="h-5 w-5" />
          <span className="font-semibold">Payment captured successfully</span>
        </div>
      ) : (
        <div className="px-4 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-gray-500 block mb-1">
                Amount (R) * <span className="text-gray-400 font-normal">Outstanding: {formatZAR(outstanding)}</span>
              </label>
              <input
                type="number"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                disabled={loading}
                className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-400"
                placeholder="0.00"
                autoFocus
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-gray-500 block mb-1">Method</label>
              <select
                value={method}
                onChange={e => setMethod(e.target.value)}
                disabled={loading}
                className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-400"
              >
                {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-[11px] font-semibold text-gray-500 block mb-1">Bank Reference</label>
            <input
              value={ref}
              onChange={e => setRef(e.target.value)}
              disabled={loading}
              className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-400"
              placeholder="e.g. TRN240104012345"
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold text-gray-500 block mb-1">Notes</label>
            <input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={loading}
              className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-400"
              placeholder="Optional"
            />
          </div>

          {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded border border-red-100">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              onClick={submit}
              disabled={loading || !amount}
              className="flex-1 py-2 rounded text-white text-sm font-medium disabled:opacity-50"
              style={{ backgroundColor: "#10B981" }}
            >
              {loading ? "Saving…" : "Confirm Payment"}
            </button>
            <button
              onClick={() => setOpen(false)}
              disabled={loading}
              className="px-4 py-2 rounded border border-gray-200 text-gray-600 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
