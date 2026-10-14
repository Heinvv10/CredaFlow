"use client"

import Link from "next/link"
import { ArrowDownWideNarrow } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { PayoutBlockBadge } from "@/components/applications/PayoutBlockBadge"
import {
  ageInDays,
  DEFAULT_COLUMN_SORT,
  payoutBlock,
  PIPELINE_COLUMNS,
  readyCount,
  SORT_LABELS,
  sortApplications,
  sortOptionsForColumn,
  type PipelineApplication,
  type SortKey,
} from "@/lib/applications/pipeline-view"
import { READY_CAVEAT, readinessSummary } from "@/lib/applications/readiness-view"
import { formatZAR } from "@/lib/utils"
import { borrowerDisplayName } from "@/lib/borrower"

function activityText(app: PipelineApplication, now: Date): string {
  const verb = app.status === "DRAFT" ? "Saved" : "Waiting"
  const days = ageInDays(app, now)
  if (days === 0) return `${verb} since today`
  if (days === 1) return `${verb} 1 day`
  return `${verb} ${days} days`
}

/**
 * The one-line readiness chip under the amount.
 *
 * Green is "every gate short of a byte check is clear", not "the API will say
 * yes" — and the title says so, because an operator reading only the chip
 * cannot see a source comment. The blockers it names, it names in the order a
 * payout attempt would hit them, and the full list is on the title so a card
 * with four does not hide three of them.
 */
function ReadinessChip({ app }: { app: PipelineApplication }) {
  if (!app.readiness) return null
  const ready = app.readiness.stage === "READY"
  return (
    <p
      className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]"
      title={ready ? READY_CAVEAT : app.readiness.blockers.join(", ")}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          ready ? "bg-[var(--cf-success)]" : "bg-[var(--cf-warning)]"
        }`}
      />
      <span className="truncate">{readinessSummary(app.readiness, app.status)}</span>
    </p>
  )
}

export function ApplicationKanban({
  applications,
  columnSort,
  onColumnSortChange,
  isFiltered,
  now,
}: {
  /** Already filtered by the workspace — this component only orders and draws. */
  applications: readonly PipelineApplication[]
  columnSort: Record<string, SortKey>
  onColumnSortChange: (status: string, key: SortKey) => void
  isFiltered: boolean
  now: Date
}) {
  return (
    <div className="grid min-h-0 flex-1 auto-rows-[minmax(280px,1fr)] gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {PIPELINE_COLUMNS.map((col) => {
        const sort = columnSort[col.key] ?? DEFAULT_COLUMN_SORT[col.key] ?? "newest"
        const apps = sortApplications(
          applications.filter((app) => app.status === col.key),
          sort,
        )
        // Only the three lanes with a gate ahead of them carry a chip, so only
        // those can report a ready count. Printing "0 ready" over Draft would
        // read as a queue standing still rather than one with nothing to do.
        const ready = apps.some((app) => app.readiness) ? readyCount(apps) : null
        return (
          <div
            key={col.key}
            className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)]"
          >
            <div className="shrink-0 border-b border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] px-4 py-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-secondary)]">
                  {col.label}
                </h3>
                <Badge className="min-w-6 justify-center px-2">
                  {ready === null ? apps.length : `${apps.length} · ${ready} ready`}
                </Badge>
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <ArrowDownWideNarrow className="h-3 w-3 shrink-0 text-[var(--cf-text-muted)]" />
                <select
                  value={sort}
                  onChange={(e) => onColumnSortChange(col.key, e.target.value as SortKey)}
                  aria-label={`Sort ${col.label}`}
                  className="w-full bg-transparent text-[11px] text-[var(--cf-text-muted)] outline-none focus:text-[var(--cf-text-secondary)]"
                >
                  {sortOptionsForColumn(col.key).map((key) => (
                    <option key={key} value={key}>{SORT_LABELS[key]}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5 pb-4">
              {apps.length === 0 ? (
                <div className="p-6 text-center">
                  <p className="text-xs text-[var(--cf-text-muted)]">No applications</p>
                  <p className="mt-0.5 text-[10px] text-[var(--cf-text-muted)]">
                    {isFiltered ? "No matches in this column" : "Create one to get started"}
                  </p>
                </div>
              ) : (
                apps.map((app) => {
                  const block = payoutBlock(app)
                  const cardBody = (
                    <>
                      <p className="mb-1 text-sm font-semibold text-[var(--cf-text)]">
                        {borrowerDisplayName(app)}
                      </p>

                      <p className="mb-3 text-[12px] text-[var(--cf-text-muted)]">
                        {app.product.name} / {activityText(app, now)}
                      </p>

                      <p className="whitespace-nowrap text-lg font-semibold text-[var(--cf-brand-soft)]">
                        {formatZAR(app.appliedAmount)}
                      </p>

                      <ReadinessChip app={app} />

                      {block ? <PayoutBlockBadge block={block} className="mt-3 max-w-full" /> : null}
                    </>
                  )

                  // DRAFT cards get a second affordance ("Edit draft" → the
                  // resumed wizard) alongside the usual detail-page link, so
                  // the card can't just be a single <Link> wrapper.
                  if (app.status !== "DRAFT") {
                    return (
                      <Link
                        key={app.id}
                        href={`/applications/${app.id}`}
                        className="block rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4 transition-colors hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-bg-subtle)]"
                      >
                        {cardBody}
                      </Link>
                    )
                  }

                  return (
                    <div
                      key={app.id}
                      className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4 transition-colors hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-bg-subtle)]"
                    >
                      <Link href={`/applications/${app.id}`} className="block">
                        {cardBody}
                      </Link>
                      <Link
                        href={`/applications/new?id=${app.id}`}
                        className="mt-2 inline-block text-xs font-medium text-[var(--cf-brand-soft)] hover:underline"
                      >
                        Edit draft
                      </Link>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
