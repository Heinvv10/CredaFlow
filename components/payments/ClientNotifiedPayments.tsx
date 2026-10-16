"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { FileText } from "lucide-react"
import { formatDate, formatZAR, SAST_TIME_ZONE } from "@/lib/utils"
import { toast } from "@/lib/toast"

export interface ClientNotifiedPayment {
  id: string
  amount: number
  reference: string | null
  paymentDate: string | null
  notes: string | null
  documentId: string
  createdAt: string
  loan: { id: string; reference: string }
  client: { firstName: string; lastName: string }
}

type Mode = { id: string; kind: "allocate" | "reject" } | null

/** YYYY-MM-DD in SAST, for the date input. */
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: SAST_TIME_ZONE })

/**
 * Payments a client reported from the portal, with proof, that nobody has
 * confirmed yet (Fair Score audit B7). A claim is not money held: allocating
 * it captures the receipt; rejecting it records why.
 */
export function ClientNotifiedPayments({ items }: { items: ClientNotifiedPayment[] }) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>(null)
  const [amount, setAmount] = useState("")
  const [receivedOn, setReceivedOn] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  function open(item: ClientNotifiedPayment, kind: "allocate" | "reject") {
    setMode({ id: item.id, kind })
    setAmount((item.amount / 100).toFixed(2))
    setReceivedOn(item.paymentDate ? dayOf(item.paymentDate) : "")
    setReason("")
    setError("")
  }

  async function submit(item: ClientNotifiedPayment) {
    if (!mode) return
    const cents = Math.round(Number.parseFloat(amount) * 100)
    const body = mode.kind === "reject"
      ? { action: "reject", reason }
      : { action: "allocate", amount: cents, ...(receivedOn ? { receivedAt: receivedOn } : {}) }
    setBusy(true)
    setError("")
    try {
      const res = await fetch(`/api/payment-notifications/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(data.error ?? "Could not update the payment notification.")
        return
      }
      toast.success(
        mode.kind === "reject" ? "Payment notification rejected" : `Payment of ${formatZAR(cents)} allocated`,
        mode.kind === "reject" ? undefined : `Captured on loan ${item.loan.reference}.`,
      )
      setMode(null)
      router.refresh()
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div id="client-notified" className="bg-white rounded-lg shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100">
        <p className="text-sm font-semibold text-gray-900">
          Awaiting reconciliation — client-notified payments ({items.length})
        </p>
        <p className="text-xs text-gray-500">
          Reported by the client in the portal with proof of payment. Not yet confirmed: check the bank
          statement, then allocate it as a receipt or reject it.
        </p>
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-500">No client-notified payments are waiting.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs uppercase text-gray-500">
              <th className="px-4 py-2">Client</th>
              <th className="px-4 py-2">Loan</th>
              <th className="px-4 py-2">Paid on</th>
              <th className="px-4 py-2">Reference</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2">Proof</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-gray-50 align-top">
                <td className="px-4 py-2">{item.client.firstName} {item.client.lastName}</td>
                <td className="px-4 py-2">
                  <Link href={`/loans/${item.loan.id}`} className="hover:underline">{item.loan.reference}</Link>
                </td>
                <td className="px-4 py-2">{item.paymentDate ? formatDate(item.paymentDate) : "—"}</td>
                <td className="px-4 py-2">{item.reference ?? "—"}</td>
                <td className="px-4 py-2 text-right font-medium">{formatZAR(item.amount)}</td>
                <td className="px-4 py-2">
                  <a href={`/api/documents/${item.documentId}/view`} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-700 hover:underline">
                    <FileText className="h-3.5 w-3.5" /> View
                  </a>
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {mode?.id === item.id ? (
                    <div className="space-y-2 text-left">
                      {mode.kind === "allocate" ? (
                        <>
                          <label className="block text-xs text-gray-600">Amount received (R)
                            <input type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
                              className="mt-1 block w-32 rounded border border-gray-200 px-2 py-1 text-sm" />
                          </label>
                          <label className="block text-xs text-gray-600">Date received
                            <input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)}
                              className="mt-1 block rounded border border-gray-200 px-2 py-1 text-sm" />
                          </label>
                        </>
                      ) : (
                        <label className="block text-xs text-gray-600">Why is it rejected?
                          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                            className="mt-1 block w-64 rounded border border-gray-200 px-2 py-1 text-sm" />
                        </label>
                      )}
                      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
                      <div className="flex gap-2">
                        <button type="button" disabled={busy} onClick={() => submit(item)}
                          className="rounded bg-gray-900 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
                          {mode.kind === "allocate" ? "Confirm allocation" : "Confirm rejection"}
                        </button>
                        <button type="button" disabled={busy} onClick={() => setMode(null)} className="text-xs text-gray-600">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => open(item, "allocate")}
                        className="rounded border border-green-300 px-2 py-1 text-xs font-semibold text-green-700 hover:bg-green-50">
                        Allocate
                      </button>
                      <button type="button" onClick={() => open(item, "reject")}
                        className="rounded border border-red-300 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">
                        Reject
                      </button>
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
