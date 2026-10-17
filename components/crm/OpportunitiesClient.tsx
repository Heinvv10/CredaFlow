"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { FilterSelect, FilterSummary, SearchInput } from "@/components/ui/list-filters"
import { matchesCentsAmount } from "@/lib/list-search"

type Client = {
  id: string
  firstName: string
  lastName: string
  phone: string
  loans: { principal: number; status: string }[]
}

type Opportunity = {
  id: string
  clientId: string
  type: string
  status: string
  assignedToId: string | null
  notes: string | null
  createdAt: Date
  client: Client
}

const TYPE_LABELS: Record<string, string> = {
  FUNERAL_COVER: "Funeral Cover",
  CREDIT_LIFE: "Credit Life",
  PERSONAL_LOAN: "Personal Loan Upsell",
  PO_FUNDING: "PO Funding",
  TOP_UP: "Loan Top-Up",
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "#F3F4F6", text: "#374151" },
  CONTACTED: { bg: "#FEF3C7", text: "#92400E" },
  INTERESTED: { bg: "#D1FAE5", text: "#065F46" },
  DECLINED: { bg: "#FEE2E2", text: "#991B1B" },
  CONVERTED: { bg: "#DCFCE7", text: "#166534" },
}

const STATUS_TABS = ["ALL", "PENDING", "CONTACTED", "INTERESTED", "DECLINED", "CONVERTED"] as const
type StatusTab = typeof STATUS_TABS[number]

function daysOpen(createdAt: Date) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000)
}

function ActionCell({
  opp,
  updating,
  onUpdate,
}: {
  opp: Opportunity
  updating: string | null
  onUpdate: (id: string, status: string) => void
}) {
  const isLoading = updating === opp.id

  if (opp.status === "PENDING") {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onUpdate(opp.id, "CONTACTED") }}
        disabled={isLoading}
        className="text-[11px] font-medium px-2.5 py-1 rounded border border-[var(--cf-border-subtle)] hover:border-[#4338CA] hover:text-[#4F46E5] transition-colors disabled:opacity-50"
      >
        {isLoading ? "..." : "Contacted"}
      </button>
    )
  }

  if (opp.status === "CONTACTED") {
    return (
      <div className="flex gap-1.5">
        <button
          onClick={(e) => { e.stopPropagation(); onUpdate(opp.id, "INTERESTED") }}
          disabled={isLoading}
          className="text-[11px] font-medium px-2.5 py-1 rounded border border-[var(--cf-border-subtle)] hover:border-[#4338CA] hover:text-[#4F46E5] transition-colors disabled:opacity-50"
        >
          {isLoading ? "..." : "Interested"}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onUpdate(opp.id, "DECLINED") }}
          disabled={isLoading}
          className="text-[11px] font-medium px-2.5 py-1 rounded border border-red-800 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
        >
          Declined
        </button>
      </div>
    )
  }

  if (opp.status === "INTERESTED") {
    return (
      <Link
        href={`/applications/new?clientId=${opp.clientId}`}
        onClick={(e) => e.stopPropagation()}
        className="text-[11px] font-medium px-2.5 py-1 rounded border border-green-800 text-green-400 hover:bg-green-900/30 transition-colors"
      >
        Create Application
      </Link>
    )
  }

  return null
}

export function OpportunitiesClient({ opportunities }: { opportunities: Opportunity[] }) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState("")
  const [statusTab, setStatusTab] = useState<StatusTab>("ALL")
  const [selected, setSelected] = useState<Opportunity | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)

  const searchQuery = search.trim().toLowerCase()
  const isFiltered = searchQuery.length > 0 || typeFilter !== "" || statusTab !== "ALL"

  const matchesSearch = (o: Opportunity) => {
    if (!searchQuery) return true
    const clientName = `${o.client.firstName} ${o.client.lastName}`.toLowerCase()
    const typeLabel = (TYPE_LABELS[o.type] ?? o.type).toLowerCase()
    if (clientName.includes(searchQuery) || typeLabel.includes(searchQuery)) return true
    // The opportunity itself carries no amount, so match on any loan shown
    // for this client (the same figure staff see in the side panel).
    if (o.client.loans.some((l) => matchesCentsAmount(search, l.principal))) return true
    return false
  }

  const filtered = useMemo(
    () =>
      opportunities.filter((o) => {
        if (typeFilter && o.type !== typeFilter) return false
        if (statusTab !== "ALL" && o.status !== statusTab) return false
        return matchesSearch(o)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opportunities, typeFilter, statusTab, search, searchQuery]
  )

  const clearFilters = () => {
    setSearch("")
    setTypeFilter("")
    setStatusTab("ALL")
  }

  const updateStatus = async (id: string, status: string) => {
    setUpdating(id)
    setUpdateError(null)
    try {
      const res = await fetch(`/api/crm/opportunities/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        setUpdateError("Failed to update status. Please try again.")
        return
      }
      router.refresh()
    } catch {
      setUpdateError("Network error. Please try again.")
    } finally {
      setUpdating(null)
    }
  }

  return (
    <div className="flex gap-6">
      <div className="flex-1 min-w-0">
        <div className="mb-4 flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[var(--cf-text)]">Cross-sell Opportunities</h1>
            {isFiltered ? (
              <div className="mt-0.5">
                <FilterSummary matched={filtered.length} total={opportunities.length} noun="opportunities" onClear={clearFilters} />
              </div>
            ) : (
              <p className="text-sm text-[var(--cf-text-muted)] mt-0.5">
                {opportunities.length} total · {opportunities.filter((o) => o.status === "CONVERTED").length} converted
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <SearchInput
              value={search}
              onChange={setSearch}
              label="Search opportunities"
              placeholder="Search name, product, amount…"
            />
            <FilterSelect
              value={typeFilter}
              onChange={setTypeFilter}
              label="Filter by type"
              options={[
                { value: "", label: "All types" },
                ...Object.entries(TYPE_LABELS).map(([v, l]) => ({ value: v, label: l })),
              ]}
            />
          </div>
        </div>

        {updateError && (
          <div className="mb-3 px-3 py-2 rounded-md bg-red-900/20 border border-red-800 text-red-400 text-sm">
            {updateError}
          </div>
        )}

        {/* Status tabs — counts reflect the search + type filters, so they
            stay consistent with what a tab switch would reveal. */}
        <div className="mb-4 flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-[var(--cf-bg-raised)] p-1">
          {STATUS_TABS.map((tab) => {
            const withinTypeAndSearch = opportunities.filter(
              (o) => (!typeFilter || o.type === typeFilter) && matchesSearch(o)
            )
            const count = tab === "ALL"
              ? withinTypeAndSearch.length
              : withinTypeAndSearch.filter((o) => o.status === tab).length
            return (
              <button
                key={tab}
                onClick={() => setStatusTab(tab)}
                className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors ${
                  statusTab === tab
                    ? "bg-[var(--cf-bg-raised)] text-[var(--cf-text)] shadow-sm"
                    : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text-secondary)]"
                }`}
              >
                {tab === "ALL" ? "All" : tab.charAt(0) + tab.slice(1).toLowerCase()}
                {" "}
                <span className="text-[10px] text-[var(--cf-text-muted)]">{count}</span>
              </button>
            )
          })}
        </div>

        <div className="bg-[var(--cf-bg-panel)] rounded-lg border border-[var(--cf-border-subtle)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)]">
                {["Client", "Product", "Status", "Days Open", "Actions"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] bg-[var(--cf-bg-raised)]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((opp) => {
                const sc = STATUS_COLORS[opp.status] ?? { bg: "#F3F4F6", text: "#374151" }
                const isSelected = selected?.id === opp.id
                return (
                  <tr
                    key={opp.id}
                    className="border-b border-[var(--cf-border-subtle)] cursor-pointer transition-colors"
                    style={{ backgroundColor: isSelected ? "rgba(79,70,229,0.15)" : "transparent" }}
                    onClick={() => setSelected(isSelected ? null : opp)}
                  >
                    <td className="px-4 py-3.5">
                      <p className="font-semibold text-[var(--cf-text)] text-[13px]">{opp.client.firstName} {opp.client.lastName}</p>
                      <p className="text-[11px] text-[var(--cf-text-muted)]">{opp.client.phone}</p>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="text-[13px] font-medium text-[var(--cf-text-secondary)]">{TYPE_LABELS[opp.type] ?? opp.type}</span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-semibold" style={{ backgroundColor: sc.bg, color: sc.text }}>
                        {opp.status.charAt(0) + opp.status.slice(1).toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-[13px] text-[var(--cf-text-secondary)]">{daysOpen(opp.createdAt)}d</td>
                    <td className="px-4 py-3.5">
                      <ActionCell opp={opp} updating={updating} onUpdate={updateStatus} />
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-[var(--cf-text-muted)] text-sm">
                    {isFiltered ? (
                      <>
                        No opportunities match these filters.{" "}
                        <button type="button" onClick={clearFilters} className="text-[var(--cf-brand-soft)] hover:underline">
                          Clear filters
                        </button>
                      </>
                    ) : (
                      "No opportunities found"
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Side panel */}
      {selected && (
        <div className="w-72 flex-shrink-0">
          <div className="bg-[var(--cf-bg-panel)] rounded-lg border border-[var(--cf-border-subtle)] p-5 sticky top-20 space-y-4">
            <div>
              <h3 className="font-bold text-[var(--cf-text)]">{selected.client.firstName} {selected.client.lastName}</h3>
              <p className="text-xs text-[var(--cf-text-muted)] mt-0.5">{selected.client.phone}</p>
            </div>
            <div className="space-y-2 text-sm border-t border-[var(--cf-border-subtle)] pt-4">
              <div className="flex justify-between">
                <span className="text-[var(--cf-text-muted)] text-xs">Product</span>
                <span className="font-medium text-xs text-[var(--cf-text-secondary)]">{TYPE_LABELS[selected.type]}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--cf-text-muted)] text-xs">Status</span>
                <span className="font-medium text-xs text-[var(--cf-text-secondary)]">{selected.status}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--cf-text-muted)] text-xs">Active Loans</span>
                <span className="font-medium text-xs text-[var(--cf-text-secondary)]">{selected.client.loans.filter((l) => l.status === "ACTIVE").length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--cf-text-muted)] text-xs">Days Open</span>
                <span className="font-medium text-xs text-[var(--cf-text-secondary)]">{daysOpen(selected.createdAt)}</span>
              </div>
            </div>
            {selected.notes && <p className="text-xs text-[var(--cf-text-secondary)] bg-[var(--cf-bg-raised)] rounded p-2">{selected.notes}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
