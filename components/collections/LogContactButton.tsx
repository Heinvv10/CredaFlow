"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "@/lib/toast"

interface Props {
  loanId: string
  clientName: string
}

const CONTACT_TYPES = [
  { value: "call_answered", label: "Call — Answered" },
  { value: "call_no_answer", label: "Call — No Answer" },
  { value: "sms", label: "SMS Sent" },
  { value: "whatsapp", label: "WhatsApp Sent" },
  { value: "email", label: "Email Sent" },
  { value: "field_visit", label: "Field Visit" },
  { value: "promise_to_pay", label: "Promise to Pay" },
  { value: "dispute", label: "Client Disputes" },
]

const OUTCOMES = [
  "Will pay by month end",
  "Paying partial amount",
  "Requested payment arrangement",
  "Disputes the balance",
  "No commitment given",
  "Number not in service",
  "Wrong number",
  "Referred to third party",
]

export function LogContactButton({ loanId, clientName }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState("call_answered")
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  // Promise-to-pay fields
  const [promiseAmount, setPromiseAmount] = useState("")
  const [promiseDate, setPromiseDate] = useState("")

  const isPtp = type === "promise_to_pay"

  async function save() {
    if (!isPtp && !note.trim()) return
    if (isPtp && (!promiseAmount || !promiseDate)) return

    setSaving(true)

    let noteBody: string
    let noteType: string

    if (isPtp) {
      noteBody = JSON.stringify({
        promiseAmount: Math.round(Number(promiseAmount) * 100),
        promiseDate,
        outcome: note.trim() || "Promise to pay recorded",
      })
      noteType = "promise_to_pay"
    } else {
      const label = CONTACT_TYPES.find((t) => t.value === type)?.label ?? type
      noteBody = `[${label}] ${note}`
      noteType = "contact"
    }

    try {
      const res = await fetch(`/api/loans/${loanId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: noteType, note: noteBody }),
      })
      if (res.ok) {
        toast.success("Contact logged")
        setDone(true)
        router.refresh()
        setTimeout(() => { setOpen(false); setDone(false); setNote(""); setPromiseAmount(""); setPromiseDate("") }, 1000)
      } else {
        toast.error("Failed to save")
      }
    } catch {
      toast.error("Network error")
    } finally {
      setSaving(false)
    }
  }

  if (done) return <button className="px-3 py-1.5 rounded text-[12px] font-semibold bg-green-100 text-green-700">Logged</button>

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 rounded text-[12px] font-semibold border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
      >
        Log Contact
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-[#1b1d24] text-lg">Log Contact</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>
            <p className="text-sm text-gray-500 mb-4">{clientName}</p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#1b1d24] mb-1">Contact Type</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5]"
                >
                  {CONTACT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>

              {/* Promise-to-pay extra fields */}
              {isPtp && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-[#1b1d24] mb-1">Promise Amount (R)</label>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={promiseAmount}
                      onChange={(e) => setPromiseAmount(e.target.value)}
                      placeholder="e.g. 5000"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[#1b1d24] mb-1">Promise Date</label>
                    <input
                      type="date"
                      value={promiseDate}
                      onChange={(e) => setPromiseDate(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5]"
                    />
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm font-medium text-[#1b1d24] mb-1">
                  {isPtp ? "Notes (optional)" : "Outcome / Notes"}
                </label>
                {!isPtp && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {OUTCOMES.map((o) => (
                      <button
                        key={o}
                        type="button"
                        onClick={() => setNote(o)}
                        className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 hover:bg-amber-50 hover:border-[#4F46E5] text-gray-600"
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder={isPtp ? "Any additional notes about the promise..." : "What happened? What was agreed?"}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5] focus:ring-1 focus:ring-[#4F46E5] resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-5">
              <button onClick={() => setOpen(false)} className="px-4 py-2 border border-gray-200 text-sm rounded-lg hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving || (!isPtp && !note.trim()) || (isPtp && (!promiseAmount || !promiseDate))}
                className="px-5 py-2 bg-[#4F46E5] text-white text-sm font-semibold rounded-lg hover:bg-[#4338CA] disabled:opacity-50"
              >
                {saving ? "Saving\u2026" : "Save Contact Log"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
