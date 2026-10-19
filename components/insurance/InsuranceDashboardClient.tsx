"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Shield, AlertCircle, TrendingUp, DollarSign, Plus, FileText } from "lucide-react"
import { formatZAR, formatRands, formatDate } from "@/lib/utils"
import { FilterSelect, FilterSummary, SearchInput } from "@/components/ui/list-filters"
import { matchesRandAmount } from "@/lib/list-search"

type Policy = {
  id: string
  policyNumber: string
  type: string
  status: string
  premiumAmount: number
  sumAssured: number
  commissionAmount: number | null
  renewalDate: Date | string
  insurer: string | null
  client: { firstName: string; lastName: string; phone: string }
  claims: { id: string; status: string; claimAmount: number }[]
}

type Claim = {
  id: string
  claimNumber: string
  status: string
  claimAmount: number
  approvedAmount: number | null
  submittedAt: Date | string
  resolvedAt?: Date | string | null
  policy: {
    type: string
    policyNumber: string
    client: { firstName: string; lastName: string }
  }
}

type Props = {
  policies: Policy[]
  claims: Claim[]
  monthlyPremiums: number
  commissionEarned: number
  openClaims: number
  totalCollected: number
}

const TYPE_LABELS: Record<string, string> = {
  FUNERAL_COVER: "Funeral Cover",
  CREDIT_LIFE: "Credit Life",
  LIFE_INSURANCE: "Life Insurance",
  SHORT_TERM_MOTOR: "Motor",
  SHORT_TERM_HOME: "Home",
}

const TYPE_COLORS: Record<string, string> = {
  FUNERAL_COVER: "bg-amber-100 text-amber-800",
  CREDIT_LIFE: "bg-blue-100 text-blue-800",
  LIFE_INSURANCE: "bg-green-100 text-green-800",
  SHORT_TERM_MOTOR: "bg-purple-100 text-purple-800",
  SHORT_TERM_HOME: "bg-indigo-100 text-indigo-800",
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  LAPSED: "bg-red-100 text-red-800",
  CANCELLED: "bg-red-100 text-red-800",
  CLAIMED: "bg-gray-100 text-gray-600",
  EXPIRED: "bg-orange-100 text-orange-800",
}

const CLAIM_COLORS: Record<string, string> = {
  SUBMITTED: "bg-amber-100 text-amber-800",
  UNDER_REVIEW: "bg-blue-100 text-blue-800",
  APPROVED: "bg-green-100 text-green-800",
  REJECTED: "bg-red-100 text-red-800",
  PAID: "bg-teal-100 text-teal-800",
}

const TABS = ["ALL", "FUNERAL", "CREDIT LIFE", "LIFE", "SHORT-TERM"]
const TAB_TYPES: Record<string, string[]> = {
  ALL: [],
  FUNERAL: ["FUNERAL_COVER"],
  "CREDIT LIFE": ["CREDIT_LIFE"],
  LIFE: ["LIFE_INSURANCE"],
  "SHORT-TERM": ["SHORT_TERM_MOTOR", "SHORT_TERM_HOME"],
}

export function InsuranceDashboardClient({ policies, claims, monthlyPremiums, commissionEarned, openClaims }: Props) {
  const [activeTab, setActiveTab] = useState("ALL")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("ALL")

  const tabPolicies = activeTab === "ALL" ? policies : policies.filter((p) => TAB_TYPES[activeTab]?.includes(p.type))

  // Options come from the WHOLE population, not the active tab. Scoping them
  // to the tab meant switching tabs could leave `status` holding a value with
  // no matching <option> — the select silently falls back to displaying
  // option[0] ("All statuses") while state keeps filtering by the old value,
  // so a tab with rows reads as empty and the dropdown claims no filter is on.
  const statuses = useMemo(
    () => Array.from(new Set(policies.map((p) => p.status))).sort(),
    [policies]
  )

  const searchQuery = search.trim().toLowerCase()
  const isFiltered = searchQuery.length > 0 || status !== "ALL"

  // Search + status match a policy independent of which tab is active, so the
  // same predicate can size both the visible rows and the tab badges — a
  // badge can never claim rows the current filter would hide.
  const matchesFilter = useMemo(() => {
    return (p: Policy) => {
      if (status !== "ALL" && p.status !== status) return false
      if (!searchQuery) return true
      const clientName = `${p.client.firstName} ${p.client.lastName}`.toLowerCase()
      if (clientName.includes(searchQuery) || p.policyNumber.toLowerCase().includes(searchQuery)) {
        return true
      }
      // Unlike Loan.principal (cents), InsurancePolicy.premiumAmount and
      // .sumAssured are Decimal RAND amounts already — formatZAR() below
      // multiplies by 100 to convert them for cents-based formatting. Hence
      // matchesRandAmount, not matchesCentsAmount.
      if (matchesRandAmount(search, p.premiumAmount) || matchesRandAmount(search, p.sumAssured)) {
        return true
      }
      return false
    }
  }, [search, searchQuery, status])

  // Filtered across ALL tabs (not just the active one) — this is what the tab
  // badges count against, so a tab's number always matches what switching to
  // it would show under the current search/status.
  const filteredAcrossTabs = useMemo(() => policies.filter(matchesFilter), [policies, matchesFilter])

  const filtered = useMemo(
    () => tabPolicies.filter(matchesFilter),
    [tabPolicies, matchesFilter]
  )

  const clearFilters = () => {
    setSearch("")
    setStatus("ALL")
  }

  const kpis = [
    {
      label: "Active Policies",
      value: String(policies.filter((p) => p.status === "ACTIVE").length),
      sub: `${policies.length} total`,
      icon: Shield,
      color: "#4F46E5",
    },
    {
      label: "Monthly Premiums",
      value: formatRands(monthlyPremiums),
      sub: "Active policies",
      icon: DollarSign,
      color: "#1e6b3f",
    },
    {
      label: "Commission Earned",
      value: formatRands(commissionEarned),
      sub: "Total commission",
      icon: TrendingUp,
      color: "#1565c0",
    },
    {
      label: "Open Claims",
      value: String(openClaims),
      sub: `${claims.length} total claims`,
      icon: AlertCircle,
      color: openClaims > 0 ? "#b71c1c" : "#1e6b3f",
    },
  ]

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1b1d24]">Insurance Management</h1>
          <p className="text-sm text-gray-500 mt-1">Policy administration, claims, and commission tracking</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/insurance/claims"
            className="flex items-center gap-2 px-4 py-2 border border-[#4F46E5] text-[#4F46E5] rounded-lg text-sm font-medium hover:bg-amber-50 transition-colors"
          >
            <FileText className="h-4 w-4" /> Claims
          </Link>
          <Link
            href="/insurance/new"
            className="flex items-center gap-2 px-4 py-2 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA] transition-colors"
          >
            <Plus className="h-4 w-4" /> Issue Policy
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {kpis.map((k) => (
          <div key={k.label} className="bg-white rounded-xl shadow-sm p-5" style={{ borderLeft: `4px solid ${k.color}` }}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{k.label}</p>
              <k.icon className="h-4 w-4" style={{ color: k.color }} />
            </div>
            <p className="whitespace-nowrap text-2xl font-extrabold text-[#1b1d24]">{k.value}</p>
            <p className="text-[11px] text-gray-400 mt-1">{k.sub}</p>
          </div>
        ))}
      </div>

      {/* Policy Table */}
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-6">
        {/* Tabs */}
        <div className="flex overflow-x-auto border-b border-gray-100 px-4 pt-2">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`shrink-0 px-4 py-2.5 text-xs font-semibold transition-colors ${
                activeTab === tab
                  ? "text-[#4F46E5] border-b-2 border-[#4F46E5]"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {tab}
              {/* Badges count against the active search/status filter (same rule as
                  the applications board Kanban columns) so a badge never claims rows
                  the user cannot currently see. With no filter active this is
                  identical to the old unfiltered total, since matchesFilter admits
                  everything. */}
              <span className="ml-1.5 text-[10px] bg-gray-100 rounded-full px-1.5 py-0.5">
                {tab === "ALL"
                  ? filteredAcrossTabs.length
                  : filteredAcrossTabs.filter((p) => TAB_TYPES[tab]?.includes(p.type)).length}
              </span>
            </button>
          ))}
        </div>

        {/* Search + status filter */}
        <div className="flex flex-col gap-2 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2.5">
            <SearchInput
              value={search}
              onChange={setSearch}
              label="Search policies"
              placeholder="Search name, policy no, amount…"
            />
            <FilterSelect
              value={status}
              onChange={setStatus}
              label="Filter by status"
              options={[
                { value: "ALL", label: "All statuses" },
                ...statuses.map((s) => ({ value: s, label: s })),
              ]}
            />
          </div>
          {isFiltered && (
            <FilterSummary matched={filtered.length} total={tabPolicies.length} noun="policies" onClear={clearFilters} />
          )}
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              <th className="px-4 py-3 text-left">Policy No</th>
              <th className="px-4 py-3 text-left">Client</th>
              <th className="px-4 py-3 text-left">Type</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right">Sum Assured</th>
              <th className="px-4 py-3 text-right">Premium/mo</th>
              <th className="px-4 py-3 text-left">Renewal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.map((p) => (
              <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 font-mono text-xs text-[#4F46E5]">
                  <Link href={`/insurance/${p.id}`} className="hover:underline">{p.policyNumber}</Link>
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-[#1b1d24] text-sm">{p.client.firstName} {p.client.lastName}</div>
                  <div className="text-[10px] text-gray-400">{p.client.phone}</div>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${TYPE_COLORS[p.type] || "bg-gray-100 text-gray-600"}`}>
                    {TYPE_LABELS[p.type] || p.type}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_COLORS[p.status] || "bg-gray-100 text-gray-600"}`}>
                    {p.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-semibold text-sm">{formatZAR(Number(p.sumAssured) * 100)}</td>
                <td className="px-4 py-3 text-right text-sm">{formatZAR(Number(p.premiumAmount) * 100)}</td>
                <td className="px-4 py-3 text-sm text-gray-600">{formatDate(p.renewalDate)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400 text-sm">
                  {isFiltered ? (
                    <>
                      No policies match these filters.{" "}
                      <button type="button" onClick={clearFilters} className="text-[#4F46E5] hover:underline">
                        Clear filters
                      </button>
                    </>
                  ) : (
                    "No policies found"
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Recent Claims */}
      {claims.length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm p-6">
          <h2 className="font-bold text-[#1b1d24] mb-4">Recent Claims</h2>
          <div className="space-y-3">
            {claims.map((c) => (
              <div key={c.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                <div>
                  <div className="font-mono text-xs text-[#4F46E5]">{c.claimNumber}</div>
                  <div className="text-sm font-medium text-[#1b1d24]">
                    {c.policy.client.firstName} {c.policy.client.lastName}
                  </div>
                  <div className="text-[11px] text-gray-400">{TYPE_LABELS[c.policy.type] || c.policy.type}</div>
                </div>
                <div className="text-right">
                  <div className="whitespace-nowrap font-semibold text-sm">{formatZAR(Number(c.claimAmount) * 100)}</div>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${CLAIM_COLORS[c.status] || "bg-gray-100"}`}>
                    {c.status.replace("_", " ")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
