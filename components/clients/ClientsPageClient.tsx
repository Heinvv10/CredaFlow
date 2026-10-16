"use client"

import { useState } from "react"
import Link from "next/link"
import { formatZAR, SAST_TIME_ZONE } from "@/lib/utils"
import { Plus, Search, CheckCircle } from "lucide-react"

type Client = {
  id: string
  firstName: string
  lastName: string
  idNumber: string
  email: string
  phone: string
  kycStatus: string
  /** Absent for a role without the loan book (lib/security/client-redaction.ts). */
  monthlyIncome?: number
  employmentStatus: string | null
  bankName: string | null
  bankAccountType?: string | null
  dateOfBirth?: Date | null
  createdAt: Date
  _count?: { loans: number; applications: number }
  loans?: { daysInArrears: number; cashPaid: number }[]
  unreadCount: number
}

const avatarColors = [
  "#4338CA", "#B91C1C", "#B45309", "#047857",
  "#1D4ED8", "#6D28D9", "#9A3412", "#0F766E",
]

function getInitials(first: string, last: string) {
  return (first[0] + last[0]).toUpperCase()
}

function getAvatarColor(initials: string) {
  let h = 0
  for (const c of initials) h += c.charCodeAt(0)
  return avatarColors[h % avatarColors.length]
}

function getActiveLoansLabel(client: Client) {
  const active = client._count?.loans ?? 0
  const overdue = (client.loans ?? []).filter(l => l.daysInArrears > 0).length
  if (overdue > 0) return { label: `${overdue} Overdue`, bg: "#FEE2E2", text: "#991B1B" }
  if (active > 0) return { label: `${active} Active`, bg: "#DCFCE7", text: "#166534" }
  return { label: "None", bg: "#F3F4F6", text: "#6B7280" }
}

function getKycStyle(status: string) {
  switch (status) {
    case "VERIFIED": return { label: "Verified", bg: "#DBEAFE", text: "#1E40AF" }
    case "PENDING": return { label: "Pending", bg: "#FEF3C7", text: "#92400E" }
    case "FAILED": return { label: "Failed", bg: "#FEE2E2", text: "#991B1B" }
    default: return { label: status, bg: "#F3F4F6", text: "#6B7280" }
  }
}

function formatDate(d?: Date | null) {
  if (!d) return "—"
  return new Date(d).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric", timeZone: SAST_TIME_ZONE })
}

/**
 * `loanBook` false (a role without view_loan_book): no loan, application,
 * repayment or income figure is shown; the page also sends none.
 */
export function ClientsPageClient({ clients, loanBook = true }: { clients: Client[]; loanBook?: boolean }) {
  const [selected, setSelected] = useState<Client | null>(null)
  const [search, setSearch] = useState("")

  const filtered = clients.filter(c => {
    const q = search.toLowerCase()
    return (
      `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
      c.idNumber.includes(q) ||
      c.phone.includes(q) ||
      c.email.toLowerCase().includes(q)
    )
  })

  const totalRepaid = (client: Client) =>
    (client.loans ?? []).reduce((s, l) => s + l.cashPaid, 0)

  return (
    <div className="flex gap-6">
      {/* Main table panel */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {clients.length} registered clients{loanBook && ` · ${clients.filter(c => (c._count?.loans ?? 0) > 0).length} with active loans`}
            </p>
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            <div className="relative w-full sm:w-auto">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by name, ID or phone..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full rounded-md border border-gray-200 bg-white py-2 pl-9 pr-4 text-sm text-gray-700 focus:outline-none sm:w-64"
              />
            </div>
            <Link href="/clients/new">
              <button
                className="flex items-center gap-2 px-4 py-2 rounded-md text-white text-sm font-medium transition-colors"
                style={{ backgroundColor: "#4338CA" }}
              >
                <Plus className="h-4 w-4" />
                + New Client
              </button>
            </Link>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
                  {["Client", "ID Number", "Phone", ...(loanBook ? ["Active Loans"] : []), "KYC Status", ""].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((client, i) => {
                  const initials = getInitials(client.firstName, client.lastName)
                  const avatarColor = getAvatarColor(initials)
                  const loanLabel = getActiveLoansLabel(client)
                  const kyc = getKycStyle(client.kycStatus)
                  const isSelected = selected?.id === client.id

                  return (
                    <tr
                      key={client.id}
                      className="border-b border-gray-50 cursor-pointer transition-colors"
                      style={{ backgroundColor: isSelected ? "#FEF3E2" : i % 2 === 0 ? "#FFFFFF" : "#FAFAFA" }}
                      onClick={() => setSelected(isSelected ? null : client)}
                    >
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[12px] font-bold flex-shrink-0"
                            style={{ backgroundColor: avatarColor }}
                          >
                            {initials}
                          </div>
                          <div>
                            <div className="flex items-center gap-1.5">
                              <p className="font-semibold text-gray-900 text-[13px]">
                                {client.firstName} {client.lastName}
                              </p>
                              {client.unreadCount > 0 && (
                                <span
                                  className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
                                  style={{ backgroundColor: "#FEF3C7", color: "#92400E" }}
                                >
                                  {client.unreadCount} unread
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-gray-400">
                              Client since {new Date(client.createdAt).toLocaleDateString("en-ZA", { month: "short", year: "numeric", timeZone: SAST_TIME_ZONE })}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-xs text-gray-600">{client.idNumber}</td>
                      <td className="px-4 py-3.5 text-[13px] text-gray-600">{client.phone}</td>
                      {loanBook && <td className="px-4 py-3.5">
                        <span
                          className="inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-semibold"
                          style={{ backgroundColor: loanLabel.bg, color: loanLabel.text }}
                        >
                          {loanLabel.label}
                        </span>
                      </td>}
                      <td className="px-4 py-3.5">
                        <span
                          className="inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-semibold"
                          style={{ backgroundColor: kyc.bg, color: kyc.text }}
                        >
                          {kyc.label}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <Link
                          href={`/clients/${client.id}`}
                          className="text-[11px] font-medium hover:underline"
                          style={{ color: "#4338CA" }}
                          onClick={e => e.stopPropagation()}
                        >
                          View →
                        </Link>
                      </td>
                    </tr>
                  )
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center">
                      <p className="text-gray-400 text-sm">No clients yet</p>
                      <p className="text-gray-300 text-xs mt-1">Add your first client to get started</p>
                      <Link href="/clients/new" className="inline-block mt-3 px-4 py-2 bg-[#4F46E5] text-white text-xs font-semibold rounded-lg hover:bg-[#4338CA]">New Client</Link>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Quick preview panel */}
      {selected && (() => {
        const initials = getInitials(selected.firstName, selected.lastName)
        const avatarColor = getAvatarColor(initials)
        const kyc = getKycStyle(selected.kycStatus)

        return (
          <div className="w-72 flex-shrink-0">
            <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-6 sticky top-20">
              {/* Avatar + name */}
              <div className="flex flex-col items-center text-center mb-5">
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold mb-3"
                  style={{ backgroundColor: avatarColor }}
                >
                  {initials}
                </div>
                <h3 className="font-bold text-gray-900 text-[15px]">{selected.firstName} {selected.lastName}</h3>
                <div className="flex items-center gap-1 mt-1">
                  <CheckCircle className="h-3.5 w-3.5" style={{ color: selected.kycStatus === "VERIFIED" ? "#27AE60" : "#E67E22" }} />
                  <span className="text-[12px]" style={{ color: selected.kycStatus === "VERIFIED" ? "#27AE60" : "#E67E22" }}>
                    KYC {kyc.label}
                  </span>
                </div>
              </div>

              {/* Details */}
              <div className="space-y-3 text-sm border-t border-gray-50 pt-4">
                {[
                  { label: "ID Number", value: selected.idNumber },
                  { label: "Date of Birth", value: selected.dateOfBirth ? formatDate(selected.dateOfBirth) : "—" },
                  { label: "Employment", value: selected.employmentStatus ? selected.employmentStatus.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : "—" },
                  ...(loanBook ? [{ label: "Income", value: <span className="whitespace-nowrap">{`${formatZAR(selected.monthlyIncome ?? 0)}/mo`}</span> }] : []),
                  { label: "Bank", value: selected.bankName ? `${selected.bankName} · ${selected.bankAccountType || "Account"}` : "—" },
                  ...(loanBook ? [
                    { label: "Loans taken", value: `${selected._count?.applications ?? 0} (${selected._count?.loans ?? 0} active)` },
                    { label: "Total repaid", value: <span className="whitespace-nowrap">{formatZAR(totalRepaid(selected))}</span> },
                  ] : []),
                ].map(row => (
                  <div key={row.label} className="flex items-center justify-between">
                    <span className="text-gray-400 text-[12px]">{row.label}</span>
                    <span className="text-gray-900 font-medium text-[12px] text-right max-w-[60%]">{row.value}</span>
                  </div>
                ))}
              </div>

              {/* View full profile */}
              <Link href={`/clients/${selected.id}`}>
                <button
                  className="w-full mt-5 py-2 rounded-md text-white text-sm font-medium transition-colors"
                  style={{ backgroundColor: "#4338CA" }}
                >
                  View Full Profile →
                </button>
              </Link>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
