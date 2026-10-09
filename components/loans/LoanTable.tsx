"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Download, Eye } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FilterSelect, FilterSummary, SearchInput } from "@/components/ui/list-filters"
import { formatDate, formatZAR } from "@/lib/utils"
import { getStatusTone } from "@/lib/status-style"
import { matchesCentsAmount } from "@/lib/list-search"

interface Loan {
  id: string
  reference: string
  principal: number
  outstandingPrincipal: number
  totalRepayable: number
  totalPaid: number
  status: string
  startDate: Date
  maturityDate: Date
  daysInArrears: number
  client: {
    firstName: string
    lastName: string
  }
  product: {
    name: string
  }
}

interface LoanTableProps {
  loans: Loan[]
}

const ARREARS_BUCKETS = [
  { key: "ALL", label: "Any arrears" },
  { key: "CLEAR", label: "Clear", match: (dpd: number) => dpd <= 0 },
  { key: "SOFT", label: "1–29 days", match: (dpd: number) => dpd >= 1 && dpd <= 29 },
  { key: "HARD", label: "30–59 days", match: (dpd: number) => dpd >= 30 && dpd <= 59 },
  { key: "DEFAULT", label: "60–89 days", match: (dpd: number) => dpd >= 60 && dpd <= 89 },
  { key: "LEGAL", label: "90+ days", match: (dpd: number) => dpd >= 90 },
] as const

function getInitials(first: string, last: string) {
  return (first[0] + last[0]).toUpperCase()
}

export function LoanTable({ loans }: LoanTableProps) {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("ALL")
  const [product, setProduct] = useState("ALL")
  const [arrears, setArrears] = useState("ALL")

  // Options come from the rows actually on the page, so a filter can never
  // offer a value that matches nothing.
  const statuses = useMemo(
    () => Array.from(new Set(loans.map((l) => l.status))).sort(),
    [loans]
  )
  const products = useMemo(
    () => Array.from(new Set(loans.map((l) => l.product.name))).sort(),
    [loans]
  )

  const searchQuery = search.trim().toLowerCase()
  const isFiltered =
    searchQuery.length > 0 || status !== "ALL" || product !== "ALL" || arrears !== "ALL"

  const filtered = useMemo(() => {
    const bucket = ARREARS_BUCKETS.find((b) => b.key === arrears)

    const matchesSearch = (loan: Loan) => {
      if (!searchQuery) return true
      const clientName = `${loan.client.firstName} ${loan.client.lastName}`.toLowerCase()
      if (
        clientName.includes(searchQuery) ||
        loan.reference.toLowerCase().includes(searchQuery) ||
        loan.product.name.toLowerCase().includes(searchQuery) ||
        loan.status.replace(/_/g, " ").toLowerCase().includes(searchQuery)
      ) {
        return true
      }
      if (matchesCentsAmount(search, loan.principal) || matchesCentsAmount(search, loan.outstandingPrincipal)) {
        return true
      }
      return false
    }

    return loans.filter(
      (loan) =>
        (status === "ALL" || loan.status === status) &&
        (product === "ALL" || loan.product.name === product) &&
        (!bucket || !("match" in bucket) || bucket.match(loan.daysInArrears)) &&
        matchesSearch(loan)
    )
  }, [loans, search, searchQuery, status, product, arrears])

  const clearFilters = () => {
    setSearch("")
    setStatus("ALL")
    setProduct("ALL")
    setArrears("ALL")
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)]">
      <div className="flex flex-col gap-4 border-b border-[var(--cf-border-subtle)] px-6 py-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--cf-text)]">All Loans</h3>
          {isFiltered ? (
            <div className="mt-0.5">
              <FilterSummary matched={filtered.length} total={loans.length} noun="loans" onClear={clearFilters} />
            </div>
          ) : (
            <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">{loans.length} records</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <SearchInput
            value={search}
            onChange={setSearch}
            label="Search loans"
            placeholder="Search name, reference, amount…"
          />
          <FilterSelect
            value={status}
            onChange={setStatus}
            label="Filter by status"
            options={[
              { value: "ALL", label: "All statuses" },
              ...statuses.map((s) => ({ value: s, label: s.replace(/_/g, " ") })),
            ]}
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
            value={arrears}
            onChange={setArrears}
            label="Filter by days in arrears"
            options={ARREARS_BUCKETS.map((b) => ({ value: b.key, label: b.label }))}
          />
        </div>
      </div>
      {loans.length === 0 ? (
        <div className="p-12 text-center">
          <p className="text-sm text-[var(--cf-text-muted)]">No loans yet</p>
          <p className="mt-1 text-xs text-[var(--cf-text-muted)]">Disbursed loans will appear here</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-12 text-center">
          <p className="text-sm text-[var(--cf-text-muted)]">No loans match these filters</p>
          <button
            type="button"
            onClick={clearFilters}
            className="mt-1 text-xs text-[var(--cf-brand-soft)] hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)]">
                {["Reference", "Client", "Product", "Principal", "Outstanding", "Status", "DPD", "Maturity", ""].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((loan) => (
                <tr
                  key={loan.id}
                  className="border-b border-[var(--cf-border-subtle)] transition-colors hover:bg-[rgba(79,70,229,0.06)]"
                >
                  <td className="px-4 py-3 font-mono text-xs text-[var(--cf-text-muted)]">{loan.reference}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.14)] text-[10px] font-semibold text-[var(--cf-brand-soft)]">
                        {getInitials(loan.client.firstName, loan.client.lastName)}
                      </div>
                      <span className="text-[13px] font-medium text-[var(--cf-text)]">
                        {loan.client.firstName} {loan.client.lastName}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[13px] text-[var(--cf-text-secondary)]">{loan.product.name}</td>
                  <td className="px-4 py-3 font-medium text-[var(--cf-text)]">{formatZAR(loan.principal)}</td>
                  <td className="px-4 py-3 font-medium text-[var(--cf-text)]">{formatZAR(loan.outstandingPrincipal)}</td>
                  <td className="px-4 py-3">
                    <Badge variant={getStatusTone(loan.status)}>{loan.status.replace(/_/g, " ")}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    {loan.daysInArrears > 0 ? (
                      <Badge variant={loan.daysInArrears > 30 ? "danger" : "warning"} className="min-w-8 justify-center">
                        {loan.daysInArrears}
                      </Badge>
                    ) : (
                      <Badge variant="success">Clear</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[13px] text-[var(--cf-text-muted)]">{formatDate(loan.maturityDate)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Button asChild variant="ghost" size="icon" className="h-8 w-8" title="Download Statement">
                        <a href={`/api/loans/${loan.id}/statement`} target="_blank" rel="noopener noreferrer">
                          <Download className="h-4 w-4" />
                        </a>
                      </Button>
                      <Button asChild variant="ghost" size="icon" className="h-8 w-8">
                        <Link href={`/loans/${loan.id}`}>
                          <Eye className="h-4 w-4" />
                        </Link>
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
