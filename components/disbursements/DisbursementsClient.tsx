"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { formatZAR } from "@/lib/utils"
import { getAvatarColor, getInitials } from "@/lib/avatar"
import { FilterSelect, FilterSummary, SearchInput } from "@/components/ui/list-filters"
import { matchesCentsAmount } from "@/lib/list-search"

interface ReadyApplication {
  id: string
  appliedAmount: number
  // Prisma types this nullable even though the query only selects EFT /
  // DEBIT_ORDER rows. Kept nullable rather than cast: an unset method is
  // labelled as unset, never folded into a real one.
  repaymentMethod: string | null
  client: {
    firstName: string
    lastName: string
  }
  product: {
    name: string
  }
}

interface DisbursementsClientProps {
  applications: ReadyApplication[]
}

const REPAYMENT_METHOD_LABELS: Record<string, string> = {
  EFT: "EFT",
  DEBIT_ORDER: "Debit order",
}

const NO_METHOD = "NONE"

function methodKey(method: string | null): string {
  return method ?? NO_METHOD
}

function methodLabel(method: string | null): string {
  if (method === null) return "Method not set"
  return REPAYMENT_METHOD_LABELS[method] ?? method
}

export function DisbursementsClient({ applications }: DisbursementsClientProps) {
  const [search, setSearch] = useState("")
  const [product, setProduct] = useState("ALL")
  const [repaymentMethod, setRepaymentMethod] = useState("ALL")

  // Options come from the rows actually on the page, so a filter can never
  // offer a value that matches nothing.
  const products = useMemo(
    () => Array.from(new Set(applications.map((a) => a.product.name))).sort(),
    [applications]
  )
  const repaymentMethods = useMemo(
    () => Array.from(new Set(applications.map((a) => methodKey(a.repaymentMethod)))).sort(),
    [applications]
  )

  const searchQuery = search.trim().toLowerCase()
  const isFiltered = searchQuery.length > 0 || product !== "ALL" || repaymentMethod !== "ALL"

  const filtered = useMemo(() => {
    const matchesSearch = (app: ReadyApplication) => {
      if (!searchQuery) return true
      const clientName = `${app.client.firstName} ${app.client.lastName}`.toLowerCase()
      if (
        clientName.includes(searchQuery) ||
        app.product.name.toLowerCase().includes(searchQuery) ||
        methodLabel(app.repaymentMethod).toLowerCase().includes(searchQuery)
      ) {
        return true
      }
      if (matchesCentsAmount(search, app.appliedAmount)) return true
      return false
    }

    return applications.filter(
      (app) =>
        (product === "ALL" || app.product.name === product) &&
        (repaymentMethod === "ALL" || methodKey(app.repaymentMethod) === repaymentMethod) &&
        matchesSearch(app)
    )
  }, [applications, search, searchQuery, product, repaymentMethod])

  const clearFilters = () => {
    setSearch("")
    setProduct("ALL")
    setRepaymentMethod("ALL")
  }

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Ready to Disburse</h3>
          <span className="text-sm font-semibold px-2.5 py-1 rounded" style={{ backgroundColor: "#D1FAE5", color: "#059669" }}>
            {applications.length} pending
          </span>
        </div>
        {applications.length > 0 && (
          <div className="flex flex-wrap items-center gap-2.5">
            <SearchInput
              value={search}
              onChange={setSearch}
              label="Search ready to disburse"
              placeholder="Search name, amount…"
              className="w-full sm:w-auto"
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
            <FilterSelect
              value={repaymentMethod}
              onChange={setRepaymentMethod}
              label="Filter by repayment method"
              options={[
                { value: "ALL", label: "All repayment methods" },
                ...repaymentMethods.map((m) => ({ value: m, label: methodLabel(m === NO_METHOD ? null : m) })),
              ]}
            />
          </div>
        )}
        {isFiltered && (
          <FilterSummary matched={filtered.length} total={applications.length} noun="applications" onClear={clearFilters} />
        )}
      </div>
      {applications.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm">No applications ready for disbursement</div>
      ) : filtered.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm">
          No applications match these filters
          <button type="button" onClick={clearFilters} className="mt-1 block w-full text-xs text-[var(--cf-brand-soft)] hover:underline">
            Clear filters
          </button>
        </div>
      ) : (
        <div className="divide-y divide-gray-50">
          {filtered.map((app) => {
            const initials = getInitials(app.client.firstName, app.client.lastName)
            const avatarColor = getAvatarColor(app.client.firstName + app.client.lastName)
            return (
              <div key={app.id} className="px-5 py-4 flex items-center justify-between hover:bg-gray-50/50">
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-white text-[12px] font-bold flex-shrink-0"
                    style={{ backgroundColor: avatarColor }}
                  >
                    {initials}
                  </div>
                  <div>
                    <Link href={`/applications/${app.id}`} className="font-semibold text-gray-900 hover:underline">
                      {app.client.firstName} {app.client.lastName}
                    </Link>
                    <p className="text-xs text-gray-400">
                      {app.product.name} • {methodLabel(app.repaymentMethod)}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="whitespace-nowrap font-bold" style={{ color: "#4338CA" }}>{formatZAR(app.appliedAmount)}</p>
                  <Link
                    href={`/applications/${app.id}`}
                    className="mt-1 inline-block text-xs font-medium px-3 py-1 rounded text-white transition-colors hover:opacity-90"
                    style={{ backgroundColor: "#27AE60" }}
                  >
                    Disburse
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
