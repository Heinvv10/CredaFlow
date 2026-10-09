"use client"

import { useState } from "react"
import { toast } from "@/lib/toast"

interface Props {
  loanId: string
  clientName: string
  arrearsAmount: number  // cents
  arrearsAmountDisplay: string
}

export function PaymentPlanButton({ loanId, clientName, arrearsAmount, arrearsAmountDisplay }: Props) {
  const [open, setOpen] = useState(false)
  const [installments, setInstallments] = useState(3)
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + 7)
    return d.toISOString().split("T")[0]
  })
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  const totalArrears = arrearsAmount / 100
  const installmentAmt = installments > 0 ? (totalArrears / installments) : 0

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/loans/${loanId}/payment-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalArrears, installments, installmentAmt, startDate, notes }),
      })
      if (res.ok) {
        toast.success("Payment plan created")
        setDone(true)
        setTimeout(() => { setOpen(false); setDone(false) }, 1000)
      } else {
        toast.error("Failed to create payment plan")
      }
    } catch {
      toast.error("Failed to create payment plan")
    } finally {
      setSaving(false)
    }
  }

  if (done) return <button className="px-3 py-1.5 rounded text-[12px] font-semibold bg-blue-100 text-blue-700">✓ Plan Set</button>

  return (
    <>
      <button onClick={() => setOpen(true)}
        className="px-3 py-1.5 rounded text-[12px] font-semibold border border-amber-400 text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors">
        Payment<br />Plan
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={e => e.target === e.currentTarget && setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-[#1b1d24] text-lg">Set Payment Plan</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <p className="text-sm text-gray-500 mb-1">{clientName}</p>
            <p className="text-sm font-semibold text-red-600 mb-4">Total in arrears: {arrearsAmountDisplay}</p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#1b1d24] mb-1">Number of Instalments</label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 6].map(n => (
                    <button key={n} type="button" onClick={() => setInstallments(n)}
                      className={`flex-1 py-2 text-sm font-semibold rounded-lg border ${installments === n ? "bg-[#4F46E5] text-white border-[#4F46E5]" : "border-gray-200 hover:bg-gray-50"}`}>
                      {n}×
                    </button>
                  ))}
                </div>
                <input type="number" min={1} max={12} value={installments}
                  onChange={e => setInstallments(Number(e.target.value) || 1)}
                  className="mt-2 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5]" />
              </div>

              <div className="bg-amber-50 rounded-xl p-4 text-center">
                <p className="text-xs text-gray-500">Monthly Payment</p>
                <p className="text-2xl font-bold text-[#4F46E5]">
                  R {installmentAmt.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                <p className="text-xs text-gray-400">{installments} × payment{installments > 1 ? "s" : ""} of arrears only</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-[#1b1d24] mb-1">First Payment Date</label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5]" />
              </div>

              <div>
                <label className="block text-sm font-medium text-[#1b1d24] mb-1">Notes (optional)</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                  placeholder="What was agreed with client?"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5] resize-none" />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-5">
              <button onClick={() => setOpen(false)}
                className="px-4 py-2 border border-gray-200 text-sm rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={save} disabled={saving}
                className="px-5 py-2 bg-[#4F46E5] text-white text-sm font-semibold rounded-lg hover:bg-[#4338CA] disabled:opacity-50">
                {saving ? "Saving…" : "Confirm Plan"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
