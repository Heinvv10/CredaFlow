"use client"

import { useMemo, useState } from "react"
import { formatZAR } from "@/lib/utils"
import { getAvatarColor, getInitials } from "@/lib/avatar"
import Link from "next/link"
import { Section129Button } from "./Section129Button"
import { LogContactButton } from "./LogContactButton"
import { PaymentPlanButton } from "./PaymentPlanButton"
import { CollectionsWaButton } from "./CollectionsWaButton"
import { FilterSelect, FilterSummary, SearchInput } from "@/components/ui/list-filters"
import { matchesCentsAmount } from "@/lib/list-search"
import { collectionsLoanKind } from "@/lib/collections/loan-kind"

interface Tab {
  key: string
  label: string
  count: number
}

interface LoanRow {
  id: string
  reference: string
  clientId: string
  daysInArrears: number
  arrearsAmount: number
  contractType?: string | null
  client: { firstName: string; lastName: string; phone: string; whatsapp?: string | null }
  product: { name: string; productType: string }
  /** The latest Section 129 attempt, when it was not sent (lib/collections/section129-failures.ts). */
  section129Failure?: { failedAt: string | Date; reason: string } | null
  notes: Array<{ createdAt: string | Date; type: string; note: string }>
  paymentPlan: { active: boolean; installments: number; installmentAmt: number; startDate: string | Date } | null
}

interface Props {
  tabs: Tab[]
  loans: LoanRow[]
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
    case "soft":    return loans.filter((l) => l.daysInArrears >= 1 && l.daysInArrears <= 29)
    case "hard":    return loans.filter((l) => l.daysInArrears >= 30 && l.daysInArrears <= 59)
    case "default": return loans.filter((l) => l.daysInArrears >= 60 && l.daysInArrears <= 89)
    case "legal":   return loans.filter((l) => l.daysInArrears >= 90)
    default:        return loans
  }
}

export function CollectionsTabs({ tabs, loans }: Props) {
  const [active, setActive] = useState("all")
  const [search, setSearch] = useState("")
  const [product, setProduct] = useState("ALL")

  const searchQuery = search.trim().toLowerCase()
  const isFiltered = searchQuery.length > 0 || product !== "ALL"

  // Shared with the per-tab badge counts below — a badge must never claim
  // rows the search/product filter has hidden from the table.
  const matchesFilters = useMemo(() => {
    return (loan: LoanRow) => {
      if (product !== "ALL" && collectionsLoanKind(loan) !== product) return false
      if (!searchQuery) return true
      const clientName = `${loan.client.firstName} ${loan.client.lastName}`.toLowerCase()
      if (clientName.includes(searchQuery) || loan.reference.toLowerCase().includes(searchQuery)) {
        return true
      }
      if (matchesCentsAmount(search, loan.arrearsAmount)) return true
      return false
    }
  }, [product, search, searchQuery])

  const tabFiltered = filterByTab(loans, active)

  // `loans` is the whole eligible population the server queried (no take/skip
  // in getCollectionsData) — the same rows the server counted `tabs` from —
  // so the badges can be recomputed client-side and will agree with the server
  // counts whenever no filter is active. Once a filter narrows what's visible,
  // the badge must narrow with it (ApplicationKanban precedent): a badge that
  // still claimed the unfiltered total would tell staff a bucket holds
  // accounts the search box has actually hidden from them.
  const tabCounts = useMemo(
    () =>
      new Map(
        tabs.map((tab) => [tab.key, filterByTab(loans, tab.key).filter(matchesFilters).length])
      ),
    [tabs, loans, matchesFilters]
  )

  // Options come from the WHOLE population, not the active tab. Scoping them
  // to the tab meant switching tabs could leave `product` holding a value with
  // no matching <option> — the select silently falls back to displaying
  // option[0] ("All products") while state keeps filtering by the old value,
  // so a tab with rows reads as empty and the dropdown claims no filter is on.
  const products = useMemo(
    () => Array.from(new Set(loans.map(collectionsLoanKind))).sort(),
    [loans]
  )

  const filtered = useMemo(() => tabFiltered.filter(matchesFilters), [tabFiltered, matchesFilters])

  const clearFilters = () => {
    setSearch("")
    setProduct("ALL")
  }

  return (
    <>
      {/* Tab bar */}
      <div className="mb-6 flex gap-1 overflow-x-auto rounded-lg bg-gray-100 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActive(tab.key)}
            className={`shrink-0 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              active === tab.key
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.label}
            <span
              className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                active === tab.key ? "bg-gray-900 text-white" : "bg-gray-200 text-gray-600"
              }`}
            >
              {tabCounts.get(tab.key) ?? tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Search + filter */}
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <SearchInput
          value={search}
          onChange={setSearch}
          label="Search collections"
          placeholder="Search name, reference, amount…"
        />
        <FilterSelect
          value={product}
          onChange={setProduct}
          label="Filter by product"
          options={[
            { value: "ALL", label: "All products" },
            ...products.map((p) => ({ value: p, label: p })),
          ]}
        />
        {isFiltered && (
          <FilterSummary matched={filtered.length} total={tabFiltered.length} noun="accounts" onClear={clearFilters} />
        )}
      </div>

      {/* Table */}
      {tabFiltered.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-16 text-center text-gray-400 text-sm">
          No accounts in this category
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-16 text-center text-gray-400 text-sm">
          No accounts match these filters
          <button type="button" onClick={clearFilters} className="block mx-auto mt-2 text-xs text-[var(--cf-brand-soft)] hover:underline">
            Clear filters
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
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

                  return (
                    <tr key={loan.id} className="border-b border-gray-50 hover:bg-gray-50/70 transition-colors">
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div
                            className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[12px] font-bold flex-shrink-0"
                            style={{ backgroundColor: avatarColor }}
                          >
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
                      <td className="px-4 py-3.5 text-[13px] text-gray-600">{collectionsLoanKind(loan)}</td>
                      <td className="px-4 py-3.5">
                        <span className="font-bold text-[15px]" style={{ color: dpdColor }}>{loan.daysInArrears}</span>
                      </td>
                      <td className="px-4 py-3.5 font-semibold text-gray-900 text-[13px]">{formatZAR(loan.arrearsAmount)}</td>
                      <td className="px-4 py-3.5">
                        <span
                          className="inline-flex items-center px-2.5 py-1 rounded text-[11px] font-semibold"
                          style={{ backgroundColor: stage.color, color: stage.textColor }}
                        >
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
                            <PaymentPlanButton
                              loanId={loan.id}
                              clientName={`${loan.client.firstName} ${loan.client.lastName}`}
                              arrearsAmount={loan.arrearsAmount}
                              arrearsAmountDisplay={formatZAR(loan.arrearsAmount)}
                            />
                          )}
                          {loan.section129Failure && (
                            <span
                              className="max-w-40 text-[10px] leading-3 text-red-700"
                              title={loan.section129Failure.reason}
                            >
                              {`S.129 not sent: ${loan.section129Failure.reason}`}
                            </span>
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
      )}
    </>
  )
}
