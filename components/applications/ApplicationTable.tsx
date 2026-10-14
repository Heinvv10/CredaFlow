"use client"

import Link from "next/link"
import { ArrowDown, ArrowUp } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { PayoutBlockBadge } from "@/components/applications/PayoutBlockBadge"
import {
  ageInDays,
  payoutBlock,
  sortApplications,
  type PipelineApplication,
  type SortKey,
} from "@/lib/applications/pipeline-view"
import { formatZAR } from "@/lib/utils"
import { borrowerDisplayName } from "@/lib/borrower"

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under Review",
  APPROVED: "Approved",
  DISBURSED: "Disbursed",
  DECLINED: "Declined",
  CANCELLED: "Cancelled",
}

/**
 * Column headers that sort. Each names the pair of sort keys it toggles
 * between, so the arrow shown is derived from the ACTIVE key rather than from
 * separate click-direction state that can disagree with the rows on screen.
 */
const SORTABLE: { label: string; asc: SortKey; desc: SortKey }[] = [
  { label: "Client", asc: "client", desc: "client" },
  { label: "Amount", asc: "amount_asc", desc: "amount_desc" },
  { label: "Age", asc: "newest", desc: "oldest" },
]

export function ApplicationTable({
  applications,
  sort,
  onSortChange,
  now,
}: {
  applications: readonly PipelineApplication[]
  sort: SortKey
  onSortChange: (key: SortKey) => void
  now: Date
}) {
  const rows = sortApplications(applications, sort)

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-12">
        <p className="text-sm text-[var(--cf-text-muted)]">
          No applications match these filters
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)]">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-[var(--cf-bg-raised)]">
          <tr className="border-b border-[var(--cf-border-subtle)] text-left">
            <Th>Reference</Th>
            {SORTABLE.map((col) => {
              const active = sort === col.asc || sort === col.desc
              const isDesc = sort === col.desc
              return (
                <th key={col.label} className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => onSortChange(isDesc ? col.asc : col.desc)}
                    aria-label={`Sort by ${col.label}`}
                    className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-secondary)] hover:text-[var(--cf-text)]"
                  >
                    {col.label}
                    {active
                      ? (isDesc
                        ? <ArrowDown className="h-3 w-3" />
                        : <ArrowUp className="h-3 w-3" />)
                      : null}
                  </button>
                </th>
              )
            })}
            <Th>Product</Th>
            <Th>Branch</Th>
            <Th>Assigned</Th>
            <Th>Status</Th>
            <Th>Payout</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((app) => {
            const block = payoutBlock(app)
            const days = ageInDays(app, now)
            return (
              <tr
                key={app.id}
                className="border-b border-[var(--cf-border-subtle)] transition-colors last:border-0 hover:bg-[var(--cf-bg-subtle)]"
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/applications/${app.id}`}
                    className="font-medium text-[var(--cf-brand-soft)] hover:underline"
                  >
                    {app.reference}
                  </Link>
                </td>
                <td className="px-4 py-3 text-[var(--cf-text)]">
                  {borrowerDisplayName(app)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-medium text-[var(--cf-text)]">
                  {formatZAR(app.appliedAmount)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-[var(--cf-text-muted)]">
                  {days === 0 ? "Today" : `${days}d`}
                </td>
                <td className="px-4 py-3 text-[var(--cf-text-muted)]">{app.product.name}</td>
                <td className="px-4 py-3 text-[var(--cf-text-muted)]">{app.branch?.name ?? "—"}</td>
                <td className="px-4 py-3 text-[var(--cf-text-muted)]">{app.assignedTo?.name ?? "—"}</td>
                <td className="px-4 py-3">
                  <Badge className="whitespace-nowrap">
                    {STATUS_LABELS[app.status] ?? app.status}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  {block ? <PayoutBlockBadge block={block} /> : <span className="text-[var(--cf-text-muted)]">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-secondary)]">
      {children}
    </th>
  )
}
