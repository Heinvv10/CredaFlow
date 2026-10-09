"use client"

import { useState } from "react"
import { formatZAR } from "@/lib/utils"
import { isPromiseKept, promiseWindow } from "@/lib/collections/promise-window"
import { isBalanceWaiver } from "@/lib/payments/waiver"

interface Note {
  id: string
  type: string
  note: string
  createdBy: string
  createdAt: string
}

interface ScheduleEntry {
  id: string
  installmentNo: number
  dueDate: string
  principalDue: number
  interestDue: number
  feesDue: number
  totalDue: number
  totalPaid: number
  status: string
}

interface Payment {
  id: string
  amount: number
  paymentMethod: string
  reference: string | null
  createdAt: string
  /** When the money ARRIVED. Promise windows bucket on this, not createdAt. */
  receivedAt: string
}

interface Props {
  notes: Note[]
  schedule: ScheduleEntry[]
  payments: Payment[]
}

function typeLabel(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function typeColor(type: string): string {
  if (type.startsWith("escalation")) return "bg-red-100 text-red-700"
  if (type.startsWith("reminder_overdue")) return "bg-orange-100 text-orange-700"
  if (type.startsWith("reminder")) return "bg-blue-100 text-blue-700"
  if (type === "section129" || type === "section129_auto") return "bg-red-100 text-red-700"
  if (type === "promise_to_pay") return "bg-green-100 text-green-700"
  if (type === "payment_plan") return "bg-purple-100 text-purple-700"
  return "bg-gray-100 text-gray-700"
}

function statusColor(s: string): string {
  if (s === "PAID") return "bg-green-100 text-green-700"
  if (s === "OVERDUE") return "bg-red-100 text-red-700"
  if (s === "PARTIAL") return "bg-yellow-100 text-yellow-700"
  return "bg-gray-100 text-gray-600"
}

// Explicit timeZone on both: without it this resolves to the JS runtime's
// local zone, which differs between the server (SSR, typically UTC) and the
// browser (SAST) — a text mismatch that trips React hydration (#418).
function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Johannesburg" })
}

function fmtDateTime(d: string) {
  return new Date(d).toLocaleString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })
}

function parsePromise(note: string): { promiseAmount: number; promiseDate: string; outcome?: string } | null {
  try {
    const parsed = JSON.parse(note)
    if (parsed.promiseAmount && parsed.promiseDate) return parsed as { promiseAmount: number; promiseDate: string; outcome?: string }
  } catch { /* not JSON */ }
  return null
}

function PromiseDetail({ note }: { note: Note }) {
  const parsed = parsePromise(note.note)
  if (!parsed) return null
  return (
    <div className="text-xs mt-1 text-gray-500">
      Promise: {formatZAR(parsed.promiseAmount)} by {fmtDate(parsed.promiseDate)}
      {parsed.outcome && <span className="ml-2">— {parsed.outcome}</span>}
    </div>
  )
}

const TABS = ["Contact History", "Promise to Pay", "Repayment Schedule"] as const

export function CollectionDetailTabs({ notes, schedule, payments }: Props) {
  const [tab, setTab] = useState<string>("Contact History")

  const promises = notes.filter((n) => n.type === "promise_to_pay")

  return (
    <>
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t ? "border-[#4F46E5] text-[#4F46E5]" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Contact History" && <ContactHistory notes={notes} />}
      {tab === "Promise to Pay" && <PromiseToPayTab promises={promises} payments={payments} />}
      {tab === "Repayment Schedule" && <ScheduleTab schedule={schedule} />}
    </>
  )
}

function ContactHistory({ notes }: { notes: Note[] }) {
  if (notes.length === 0) {
    return <p className="text-sm text-gray-400 py-8 text-center">No contact history yet</p>
  }
  return (
    <div className="space-y-3">
      {notes.map((n) => (
        <div key={n.id} className="bg-white rounded-lg border border-gray-100 p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${typeColor(n.type)}`}>
                {typeLabel(n.type)}
              </span>
              <span className="text-xs text-gray-400">{fmtDateTime(n.createdAt)}</span>
            </div>
            <span className="text-xs text-gray-400">{n.createdBy}</span>
          </div>
          <p className="text-sm text-gray-700 mt-2">{n.type === "promise_to_pay" ? "" : n.note}</p>
          {n.type === "promise_to_pay" && <PromiseDetail note={n} />}
        </div>
      ))}
    </div>
  )
}

// Exported for test only: this tab decides Kept vs Broken, which feeds
// collections escalation and ultimately s129, and it is not reachable by a
// static render through the parent's tab state.
export function PromiseToPayTab({ promises, payments }: { promises: Note[]; payments: Payment[] }) {
  if (promises.length === 0) {
    return <p className="text-sm text-gray-400 py-8 text-center">No promise-to-pay records</p>
  }
  return (
    <div className="space-y-3">
      {promises.map((p) => {
        let promiseAmount = 0
        let promiseDate = ""
        let outcome = ""
        try {
          const parsed = JSON.parse(p.note)
          promiseAmount = parsed.promiseAmount ?? 0
          promiseDate = parsed.promiseDate ?? ""
          outcome = parsed.outcome ?? ""
        } catch { /* not JSON */ }

        // Did the money ARRIVE in the promise window — not: was it captured then.
        const pdObj = promiseDate ? new Date(promiseDate) : null
        const window = promiseDate
          ? promiseWindow({
              noteCreatedAt: new Date(p.createdAt),
              promiseDate: new Date(promiseDate),
            })
          : null
        const relevantPayments = window
          ? payments.filter((pay) => {
              // A waived balance does not keep a promise to pay.
              if (isBalanceWaiver(pay.paymentMethod)) return false
              const payDate = new Date(pay.receivedAt)
              return payDate >= window.start && payDate <= window.end
            })
          : []
        const totalReceived = relevantPayments.reduce((s, pay) => s + pay.amount, 0)
        const kept = isPromiseKept({ promiseAmount, totalReceived })

        return (
          <div key={p.id} className="bg-white rounded-lg border border-gray-100 p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="whitespace-nowrap text-sm font-semibold text-gray-900">
                  {promiseAmount > 0 ? formatZAR(promiseAmount) : "Amount not specified"}
                </span>
                {promiseDate && <span className="text-sm text-gray-500 ml-2">by {fmtDate(promiseDate)}</span>}
              </div>
              <span className={`text-xs font-semibold px-2 py-1 rounded-full ${kept ? "bg-green-100 text-green-700" : pdObj && pdObj < new Date() ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}`}>
                {kept ? "Kept" : pdObj && pdObj < new Date() ? "Broken" : "Pending"}
              </span>
            </div>
            {outcome && <p className="text-sm text-gray-500 mt-1">{outcome}</p>}
            {totalReceived > 0 && (
              <p className="text-xs text-gray-400 mt-1">Payment received: {formatZAR(totalReceived)}</p>
            )}
            <p className="text-xs text-gray-400 mt-1">Logged by {p.createdBy} on {fmtDateTime(p.createdAt)}</p>
          </div>
        )
      })}
    </div>
  )
}

function ScheduleTab({ schedule }: { schedule: ScheduleEntry[] }) {
  return (
    <div className="bg-white rounded-lg border border-gray-100 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
              {["#", "Due Date", "Principal", "Interest", "Fees", "Total", "Paid", "Status"].map((h) => (
                <th key={h} className="px-3 py-2.5 text-left font-semibold uppercase tracking-wider" style={{ fontSize: "10px", color: "#9CA3AF" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {schedule.map((s) => (
              <tr key={s.id} className={`border-b border-gray-50 ${s.status === "OVERDUE" ? "bg-red-50/50" : ""}`}>
                <td className="px-3 py-2 text-gray-500">{s.installmentNo}</td>
                <td className="px-3 py-2 text-gray-700">{fmtDate(s.dueDate)}</td>
                <td className="px-3 py-2 text-gray-700">{formatZAR(s.principalDue)}</td>
                <td className="px-3 py-2 text-gray-700">{formatZAR(s.interestDue)}</td>
                <td className="px-3 py-2 text-gray-700">{formatZAR(s.feesDue)}</td>
                <td className="px-3 py-2 font-semibold text-gray-900">{formatZAR(s.totalDue)}</td>
                <td className="px-3 py-2 text-gray-700">{formatZAR(s.totalPaid)}</td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusColor(s.status)}`}>
                    {s.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
