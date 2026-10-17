import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { Download, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { prisma } from "@/lib/prisma"
import { formatZAR, SAST_TIME_ZONE } from "@/lib/utils"
import { getStaffTenantId } from "@/lib/session-tenant"
import { loadChargesOwingByBand } from "@/lib/reports/charges-owing"
import { getBookArrears, overdueWhere } from "@/lib/reports/book-arrears"
import { AGING_LOAN_INCLUDE, AgingTable } from "./AgingTable"

function bucketTone(label: string) {
  // Matched against ARREARS_BANDS labels — a stale literal here silently
  // downgrades a band to neutral rather than failing.
  if (label === "90+ DPD" || label === "61-89 DPD") return "danger" as const
  if (label === "31-60 DPD") return "warning" as const
  return "neutral" as const
}

async function getAgingData() {
  const tenantId = await getStaffTenantId()
  // "In arrears" is the book's (lib/reports/book-arrears.ts): the bands, the
  // totals and the rows are the same population as every other screen.
  // Written-off accounts are not in the collectible book; they are listed
  // apart, with their own totals, for collections follow-up.
  const [book, loans, writtenOff, charges] = await Promise.all([
    getBookArrears(tenantId),
    prisma.loan.findMany({ where: overdueWhere(tenantId), include: AGING_LOAN_INCLUDE, orderBy: { daysInArrears: "desc" } }),
    prisma.loan.findMany({
      where: { tenantId, status: "WRITTEN_OFF", daysInArrears: { gt: 0 } },
      include: AGING_LOAN_INCLUDE,
      orderBy: { daysInArrears: "desc" },
    }),
    loadChargesOwingByBand(prisma, tenantId, [...COLLECTIBLE_STATUSES]),
  ])
  return { book, loans, writtenOff, charges }
}

export default async function ArrearsAgingPage() {
  const { book, loans, writtenOff, charges } = await getAgingData()
  const grandTotalArrears = book.ageing.reduce((sum, band) => sum + band.arrearsAmount, 0)
  const sumOf = (key: "arrearsAmount" | "outstandingPrincipal") => writtenOff.reduce((sum, loan) => sum + loan[key], 0)

  return (
    <div className="space-y-6 px-4 py-5 lg:px-8 lg:py-7">
      <div className="flex flex-col gap-4 border-b border-[var(--cf-border-subtle)] pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <Breadcrumbs
            className="mb-3"
            items={[
              { label: "Reports", href: "/reports" },
              { label: "Arrears aging" },
            ]}
          />
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">Portfolio Risk</p>
          <h1 className="mt-2 text-2xl font-semibold text-[var(--cf-text)]">Arrears Aging Report</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--cf-text-muted)]">
            Monitor overdue exposure by delinquency bucket, collections stage and next payment date.
          </p>
        </div>
        <Button asChild>
          <a href="/api/reports/export?type=par" download>
            <Download className="h-4 w-4" />
            Export to Excel
          </a>
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {book.ageing.map(({ label, count, arrearsAmount, outstandingPrincipal }) => (
          <MetricCard
            key={label}
            label={label}
            value={count}
            detail={`${formatZAR(arrearsAmount)} arrears / ${formatZAR(outstandingPrincipal)} outstanding${
              charges.chargesLive ? ` / ${formatZAR(charges.byBand[label as keyof typeof charges.byBand])} default charges` : ""
            }`}
            tone={bucketTone(label)}
          />
        ))}
      </div>

      <DataPanel>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className={`grid gap-4 ${charges.chargesLive ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cf-text-muted)]">Accounts in Arrears</p>
              <p className="mt-1 text-xl font-semibold text-[var(--cf-text)]">{book.arrears.count}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cf-text-muted)]">Total Arrears</p>
              <p className="mt-1 text-xl font-semibold text-[var(--cf-danger)]">{formatZAR(grandTotalArrears)}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cf-text-muted)]">Total Outstanding</p>
              <p className="mt-1 text-xl font-semibold text-[var(--cf-text)]">{formatZAR(book.arrears.outstandingPrincipal)}</p>
            </div>
            {charges.chargesLive && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cf-text-muted)]">Default Charges Owing</p>
                <p className="mt-1 text-xl font-semibold text-[var(--cf-text)]">{formatZAR(charges.total)}</p>
                {charges.notInArrears.count > 0 && (
                  <p className="mt-0.5 text-[11px] text-[var(--cf-text-muted)]">
                    incl. {formatZAR(charges.notInArrears.amount)} on {charges.notInArrears.count} {charges.notInArrears.count === 1 ? "loan" : "loans"} with no instalment arrears
                  </p>
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-[var(--cf-text-muted)]">
            {charges.chargesLive && "Arrears are unpaid instalments only; default charges are shown beside them, as at the last nightly update. "}
            Outstanding is principal only.{" "}
            Generated {new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "long", year: "numeric", timeZone: SAST_TIME_ZONE })}
          </p>
        </div>
      </DataPanel>

      <DataPanel title="Account Detail" description="Drill into clients requiring arrears action.">
        {loans.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No accounts in arrears"
            description="The active loan book has no overdue accounts. Use Collections for payment arrangements, reminders and S129 workflows when arrears appear."
            action={{ label: "Open Collections", href: "/collections" }}
          />
        ) : (
          <AgingTable loans={loans} chargesLive={charges.chargesLive} />
        )}
      </DataPanel>

      {writtenOff.length > 0 && (
        <DataPanel
          title="Written Off"
          description={`Not in the collectible book or the figures above: ${writtenOff.length} ${writtenOff.length === 1 ? "account" : "accounts"}, ${formatZAR(sumOf("arrearsAmount"))} arrears, ${formatZAR(sumOf("outstandingPrincipal"))} outstanding.`}
        >
          <AgingTable loans={writtenOff} chargesLive={false} />
        </DataPanel>
      )}
    </div>
  )
}
