"use client"

import { useState, useEffect } from "react"
import { formatZAR } from "@/lib/utils"
import { getAvatarColor, getInitials } from "@/lib/avatar"
import Link from "next/link"
import { Section129Button } from "./Section129Button"
import { LogContactButton } from "./LogContactButton"
import { PaymentPlanButton } from "./PaymentPlanButton"
import { CollectionsWaButton } from "./CollectionsWaButton"
import { BulkAttorneyReferModal } from "./BulkAttorneyReferModal"
import { useRouter } from "next/navigation"
import { Briefcase } from "lucide-react"

interface LoanRow {
  id: string
  reference: string
  clientId: string
  daysInArrears: number
  arrearsAmount: number
  client: { firstName: string; lastName: string; phone: string; whatsapp?: string | null }
  product: { name: string; productType: string }
  notes: Array<{ createdAt: string | Date; type: string; note: string }>
  paymentPlan: { active: boolean; installments: number; installmentAmt: number; startDate: string | Date } | null
}

interface Props {
  loans: LoanRow[]
  activeTab: string
}

function getStage(dpd: number) {
  if (dpd >= 90) return { label: "Legal", color: "#FEE2E2", textColor: "#991B1B" }
  if (dpd >= 60) return { label: "Default Risk", color: "#FEF3C7", textColor: "#92400E" }
  if (dpd >= 30) return { label: "Hard Call", color: "#FEF3C7", textColor: "#92400E" }
  return { label: "Soft Call", color: "#E0E7FF", textColor: "#3730A3" }
}

function getDpdColor(dpd: number) {
  if (dpd >= 90) return "#E74C3C"
  if (dpd >= 60) return "#E67E22"
  if (dpd >= 30) return "#F59E0B"
  return "#6B7280"
}

function getProductShort(pt: string) {
  if (pt === "MICRO" || pt === "MICRO30") return "Micro"
  if (pt === "PERSONAL") return "Personal"
  if (pt === "PO_FUNDING" || pt === "POFUND") return "PO Fund"
  if (pt === "ASSET_FINANCE") return "Asset finance"
  return pt
}

function lastContactText(date: Date | string | null | undefined) {
  if (!date) return "Never"
  const diff = Date.now() - new Date(date).getTime()
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor(diff / 3600000)
  if (hours < 1) return "Just now"
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return "Yesterday"
  if (days < 7) return `${days}d ago`
  // Explicit timeZone: without it this resolves to the JS runtime's local
  // zone, which differs between the server (SSR, typically UTC) and the
  // browser (SAST) — a text mismatch that trips React hydration (#418).
  return new Date(date).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", timeZone: "Africa/Johannesburg" })
}

function filterByTab(loans: LoanRow[], tab: string): LoanRow[] {
  switch (tab) {
    case "soft": return loans.filter((l) => l.daysInArrears >= 1 && l.daysInArrears <= 29)
    case "hard": return loans.filter((l) => l.daysInArrears >= 30 && l.daysInArrears <= 59)
    case "default": return loans.filter((l) => l.daysInArrears >= 60 && l.daysInArrears <= 89)
    case "legal": return loans.filter((l) => l.daysInArrears >= 90)
    default: return loans
  }
}

export function CollectionsTable({ loans, activeTab }: Props) {
  const filtered = filterByTab(loans, activeTab)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkRefer, setShowBulkRefer] = useState(false)
  const router = useRouter()

  useEffect(() => {
    Promise.resolve().then(() => setSelectedIds(new Set()))
  }, [activeTab])

  const allSelected = filtered.length > 0 && filtered.every((l) => selectedIds.has(l.id))

  function toggleAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allSelected) filtered.forEach((l) => next.delete(l.id))
      else filtered.forEach((l) => next.add(l.id))
      return next
    })
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedInView = filtered.filter((l) => selectedIds.has(l.id)).map((l) => l.id)

  if (filtered.length === 0) {
    return <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-16 text-center text-gray-400 text-sm">No accounts in this category</div>
  }

  return (
    <div className="space-y-2">
      {/* Bulk action bar */}
      {selectedInView.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-purple-50 border border-purple-200 rounded-lg text-sm">
          <span className="text-purple-800 font-medium">{selectedInView.length} loan{selectedInView.length !== 1 ? "s" : ""} selected</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowBulkRefer(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 transition-colors"
            >
              <Briefcase className="h-3.5 w-3.5" />
              Refer to Attorney
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-purple-600 hover:text-purple-800 text-xs underline"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
                <th className="px-4 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="rounded border-gray-300 text-purple-600 focus:ring-purple-400"
                  />
                </th>
                {["Client", "Loan Ref", "Product", "DPD", "Arrears", "Stage", "Last Contact", "Actions"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-semibold uppercase tracking-wider" style={{ fontSize: "11px", color: "#9CA3AF" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((loan) => {
                const initials = getInitials(loan.client.firstName, loan.client.lastName)
                const avatarColor = getAvatarColor(loan.client.firstName + loan.client.lastName)
                const stage = getStage(loan.daysInArrears)
                const dpdColor = getDpdColor(loan.daysInArrears)
                const lastContact = lastContactText(loan.notes[0]?.createdAt)
                const isSelected = selectedIds.has(loan.id)

                return (
                  <tr
                    key={loan.id}
                    className={`border-b border-gray-50 hover:bg-gray-50/70 transition-colors ${isSelected ? "bg-purple-50/40" : ""}`}
                  >
                    <td className="px-4 py-3.5">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(loan.id)}
                        className="rounded border-gray-300 text-purple-600 focus:ring-purple-400"
                      />
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[12px] font-bold flex-shrink-0" style={{ backgroundColor: avatarColor }}>
                          {initials}
                        </div>
                        <Link href={`/clients/${loan.clientId}`} className="font-semibold text-gray-900 hover:underline text-[13px]">
                          {loan.client.firstName.charAt(0)}. {loan.client.lastName}
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <Link href={`/collections/${loan.id}`} className="font-mono text-xs text-gray-600 hover:text-gray-900">
                        {loan.reference}
                      </Link>
                      {loan.paymentPlan?.active && (
                        <span className="block text-[10px] font-semibold text-blue-600 mt-0.5">Plan active</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-[13px] text-gray-600">{getProductShort(loan.product.productType)}</td>
                    <td className="px-4 py-3.5">
                      <span className="font-bold text-[15px]" style={{ color: dpdColor }}>{loan.daysInArrears}</span>
                    </td>
                    <td className="px-4 py-3.5 font-semibold text-gray-900 text-[13px]">{formatZAR(loan.arrearsAmount)}</td>
                    <td className="px-4 py-3.5">
                      <span className="inline-flex items-center px-2.5 py-1 rounded text-[11px] font-semibold" style={{ backgroundColor: stage.color, color: stage.textColor }}>
                        {stage.label}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-[13px] text-gray-400">{lastContact}</td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1">
                        {loan.daysInArrears >= 90 ? (
                          <Section129Button loanId={loan.id} loanRef={loan.reference} clientName={`${loan.client.firstName} ${loan.client.lastName}`} />
                        ) : loan.daysInArrears >= 30 ? (
                          <LogContactButton loanId={loan.id} clientName={`${loan.client.firstName} ${loan.client.lastName}`} />
                        ) : (
                          <PaymentPlanButton loanId={loan.id} clientName={`${loan.client.firstName} ${loan.client.lastName}`} arrearsAmount={loan.arrearsAmount} arrearsAmountDisplay={formatZAR(loan.arrearsAmount)} />
                        )}
                        <CollectionsWaButton
                          clientId={loan.clientId}
                          clientName={`${loan.client.firstName} ${loan.client.lastName}`}
                          phone={loan.client.whatsapp ?? loan.client.phone}
                          daysInArrears={loan.daysInArrears}
                        />
                        <Link href={`/collections/${loan.id}`} className="px-2 py-1.5 rounded text-[11px] font-semibold text-gray-500 hover:bg-gray-100 transition-colors">
                          View
                        </Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showBulkRefer && (
        <BulkAttorneyReferModal
          loanIds={selectedInView}
          onClose={() => setShowBulkRefer(false)}
          onSuccess={() => {
            setShowBulkRefer(false)
            setSelectedIds(new Set())
            router.refresh()
          }}
        />
      )}
    </div>
  )
}
