"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Smartphone } from "lucide-react"
import { formatZAR } from "@/lib/utils"
import type { LoanOption } from "@/components/portal/StitchPaymentForm"

// English only, like the Kenyan portal it serves (the exception is recorded in
// lib/i18n/.claude.md): the catalogue is not touched, so no reviewed af/zu/xh
// translation goes stale for a panel only a lender with an M-Pesa paybill
// shows. Swahili is out of scope (KE plan).
const STATUS_TEXT: Record<string, string> = {
  BOOKED: "Payment received. Your loan balance has been updated.",
  DUPLICATE: "This payment was already received.",
  HELD: "Payment received. Our team will allocate it to your loan shortly.",
  NEEDS_REVIEW: "Payment received. Our team will allocate it to your loan shortly.",
  CANCELLED: "The M-Pesa request was cancelled on your phone. Nothing was paid.",
  PENDING: "Check your phone and enter your M-Pesa PIN to complete the payment.",
}

interface Props {
  paybill: string
  loans: LoanOption[]
  /** "Pay with M-Pesa" (STK push) may run here. */
  stkPush: boolean
  /** The borrower's phone on file, prefilled; they may use another. */
  phone: string
}

/** Whole shillings: M-Pesa takes no cents. */
function wholeUnits(cents: number): string {
  return String(Math.ceil(cents / 100))
}

export function MpesaPaymentPanel({ paybill, loans, stkPush, phone: phoneOnFile }: Props) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState(loans[0]?.id ?? "")
  const [amount, setAmount] = useState(() => (loans[0] ? wholeUnits(loans[0].paymentDefault) : ""))
  const [phone, setPhone] = useState(phoneOnFile)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  if (loans.length === 0) return null
  const selected = loans.find((l) => l.id === selectedId) ?? loans[0]

  function chooseLoan(id: string) {
    setSelectedId(id)
    const loan = loans.find((l) => l.id === id)
    if (loan) setAmount(wholeUnits(loan.paymentDefault))
  }

  async function pay(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)
    const units = Number(amount)
    if (!Number.isSafeInteger(units) || units <= 0) {
      setMessage({ text: "Enter a whole amount greater than zero.", error: true })
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/portal/payment/mpesa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanId: selected.id, amount: units, phone }),
      })
      const json = (await res.json()) as { status?: string; error?: string; maxAmountCents?: number }
      if (res.status === 422 && typeof json.maxAmountCents === "number") {
        setMessage({ text: `The amount exceeds today’s settlement amount of ${formatZAR(json.maxAmountCents)}.`, error: true })
      } else if ([400, 409, 429].includes(res.status) && json.error) {
        setMessage({ text: json.error, error: true })
      } else if (!res.ok || !json.status) {
        setMessage({ text: "M-Pesa payment is temporarily unavailable. Please use the paybill details above.", error: true })
      } else {
        setMessage({ text: STATUS_TEXT[json.status] ?? STATUS_TEXT.PENDING, error: json.status === "CANCELLED" })
        router.refresh()
      }
    } catch {
      setMessage({ text: "An unexpected error occurred. Please try again.", error: true })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-6 mb-5">
      <div className="flex items-center gap-2 mb-4">
        <Smartphone className="h-4 w-4 text-[var(--cf-brand)]" />
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Pay with M-Pesa</p>
      </div>
      <div className="space-y-3 text-sm">
        <div className="flex justify-between items-center py-2 border-b border-gray-50">
          <span className="text-gray-500">Paybill number</span>
          <span className="font-mono font-semibold text-gray-800">{paybill}</span>
        </div>
        <div className="flex justify-between items-center py-2 border-b border-gray-50">
          <span className="text-gray-500">Account number</span>
          <span className="font-mono font-semibold text-gray-800">{selected.reference}</span>
        </div>
      </div>
      <p className="text-[11px] text-gray-400 mt-3">
        On your phone: M-Pesa, Lipa na M-Pesa, Pay Bill. Enter the paybill number, then your loan reference as the account number.
      </p>

      {stkPush && (
        <form onSubmit={pay} className="mt-5 space-y-4">
          {loans.length > 1 && (
            <div>
              <label htmlFor="mpesa-loan" className="block text-sm font-medium text-gray-700 mb-1">Loan</label>
              <select id="mpesa-loan" value={selected.id} onChange={(e) => chooseLoan(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
                {loans.map((l) => <option key={l.id} value={l.id}>{l.reference}</option>)}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="mpesa-amount" className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
            <input id="mpesa-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" required />
          </div>
          <div>
            <label htmlFor="mpesa-phone" className="block text-sm font-medium text-gray-700 mb-1">M-Pesa phone number</label>
            <input id="mpesa-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" required />
          </div>
          {message && (
            <p role="status" className={`text-sm ${message.error ? "text-red-600" : "text-green-700"}`}>{message.text}</p>
          )}
          <button type="submit" disabled={loading}
            className="w-full rounded-lg bg-[var(--cf-brand)] px-4 py-2.5 text-sm font-semibold text-[var(--cf-on-brand)] disabled:opacity-60">
            {loading ? "Sending the request to your phone…" : "Pay with M-Pesa"}
          </button>
        </form>
      )}
    </div>
  )
}
