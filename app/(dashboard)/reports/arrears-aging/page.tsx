import Link from "next/link"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { arrearsBucket, ARREARS_BANDS } from "@/lib/reports/arrears-buckets"
import { Download, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { MetricCard } from "@/components/app-shell/MetricCard"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { prisma } from "@/lib/prisma"
import { formatDate, formatZAR, SAST_TIME_ZONE } from "@/lib/utils"
import { getStaffTenantId } from "@/lib/session-tenant"
import { chargesOwing, loadChargesOwingByBand } from "@/lib/reports/charges-owing"
import { borrowerDisplayName } from "@/lib/borrower"

const STAGE_LABELS: Record<string, string> = {
  NONE: "No Action",
  SOFT_REMINDER: "Soft Reminder",
  FORMAL_REMINDER: "Formal Reminder",
  SECTION_129_SENT: "S.129 Issued",
  PAYMENT_ARRANGEMENT: "Arrangement",
  ATTORNEY_REFERRED: "Attorney",
  WRITTEN_OFF: "Written Off",
}

const STAGE_COLORS: Record<string, string> = {
  NONE: "var(--cf-text-muted)",
  SOFT_REMINDER: "var(--cf-info)",
  FORMAL_REMINDER: "var(--cf-warning)",
  SECTION_129_SENT: "var(--cf-danger)",
  PAYMENT_ARRANGEMENT: "var(--cf-success)",
  ATTORNEY_REFERRED: "var(--cf-brand)",
  WRITTEN_OFF: "var(--cf-text-muted)",
}

function bucketColor(days: number) {
  if (days <= 60) return "var(--cf-warning)"
  return "var(--cf-danger)"
}

function bucketTone(label: string) {
  // Matched against ARREARS_BANDS labels — a stale literal here silently
  // downgrades a band to neutral rather than failing.
  if (label === "90+ DPD" || label === "61-89 DPD") return "danger" as const
  if (label === "31-60 DPD") return "warning" as const
  return "neutral" as const
}

async function getAgingData() {
  const tenantId = await getStaffTenantId()
  // The same statuses as the rows below. The total also counts loans with no
  // instalment arrears (not listed as rows); the page states that part separately.
  const charges = await loadChargesOwingByBand(prisma, tenantId, [...COLLECTIBLE_STATUSES, "WRITTEN_OFF"])
  const loans = await prisma.loan.findMany({
    where: {
      tenantId,
      daysInArrears: { gt: 0 },
      // The collectible book PLUS written-off accounts. The addition is
      // deliberate — this is a collections drill-down and every row carries a
      // status label and colour, so a written-off account is legible as such —
      // and it is the ONE place that deviates from lib/loan/collectible-book.ts.
      //
      // Note the consequence, which is not yet decided: the headline "Total
      // Arrears" and "Total Outstanding" below therefore mix written-off debt
      // into totals that read as collectible. The per-row status makes the
      // detail honest; the totals do not say it.
      //
      // The rest of the list is the shared book, so this page no longer
      // disagrees with the board pack and the reports overview about
      // PENDING_WRITE_OFF and RESTRUCTURED, which it previously omitted while
      // they included them.
      status: { in: [...COLLECTIBLE_STATUSES, "WRITTEN_OFF"] },
    },
    include: {
      client: { select: { firstName: true, lastName: true, idNumber: true, phone: true } },
      entity: { select: { legalName: true } },
      product: { select: { name: true } },
    },
    orderBy: { daysInArrears: "desc" },
  })

  // Keys derived from ARREARS_BANDS, not written out again: a hardcoded list
  // that drifts from the bucket function indexes an undefined entry and throws
  // on the first loan in the missing band.
  const totals = Object.fromEntries(
    ARREARS_BANDS.map((b) => [b.label, { count: 0, arrears: 0, outstanding: 0 }]),
  ) as Record<string, { count: number; arrears: number; outstanding: number }>

  for (const loan of loans) {
    const group = arrearsBucket(loan.daysInArrears)
    totals[group].count += 1
    totals[group].arrears += loan.arrearsAmount
    totals[group].outstanding += loan.outstandingPrincipal
  }

  return { loans, totals, charges }
}

export default async function ArrearsAgingPage() {
  const { loans, totals, charges } = await getAgingData()
  const grandTotalArrears = loans.reduce((sum, loan) => sum + loan.arrearsAmount, 0)
  const grandTotalOutstanding = loans.reduce((sum, loan) => sum + loan.outstandingPrincipal, 0)

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
        {Object.entries(totals).map(([label, total]) => (
          <MetricCard
            key={label}
            label={label}
            value={total.count}
            detail={`${formatZAR(total.arrears)} arrears / ${formatZAR(total.outstanding)} outstanding${
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
              <p className="mt-1 text-xl font-semibold text-[var(--cf-text)]">{loans.length}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cf-text-muted)]">Total Arrears</p>
              <p className="mt-1 text-xl font-semibold text-[var(--cf-danger)]">{formatZAR(grandTotalArrears)}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cf-text-muted)]">Total Outstanding</p>
              <p className="mt-1 text-xl font-semibold text-[var(--cf-text)]">{formatZAR(grandTotalOutstanding)}</p>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>ID Number</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">DPD</TableHead>
                <TableHead>Bucket</TableHead>
                <TableHead className="text-right">Arrears</TableHead>
                {charges.chargesLive && <TableHead className="text-right">Default charges</TableHead>}
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Oldest Unpaid Due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loans.map((loan) => {
                const dpd = loan.daysInArrears
                const group = arrearsBucket(dpd)
                const groupColor = bucketColor(dpd)
                const stage = loan.collectionsStage ?? "NONE"
                const stageColor = STAGE_COLORS[stage] ?? "#9CA3AF"

                return (
                  <TableRow key={loan.id}>
                    <TableCell>
                      <Link href={`/collections/${loan.id}`} className="font-medium text-[var(--cf-text)] hover:text-[var(--cf-brand-soft)]">
                        {borrowerDisplayName(loan)}
                      </Link>
                      <p className="text-[11px] text-[var(--cf-text-muted)]">{loan.reference}</p>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{loan.client?.idNumber ?? "—"}</TableCell>
                    <TableCell>{loan.product.name}</TableCell>
                    <TableCell className="text-right font-bold" style={{ color: groupColor }}>{dpd}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold" style={{ color: groupColor, background: `color-mix(in srgb, ${groupColor} 12%, transparent)` }}>
                        {group}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-medium text-[var(--cf-danger)]">{formatZAR(loan.arrearsAmount)}</TableCell>
                    {charges.chargesLive && <TableCell className="text-right">{formatZAR(chargesOwing(loan, charges.chargesLive))}</TableCell>}
                    <TableCell className="text-right">{formatZAR(loan.outstandingPrincipal)}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold" style={{ color: stageColor, background: `color-mix(in srgb, ${stageColor} 12%, transparent)` }}>
                        {STAGE_LABELS[stage] ?? stage}
                      </span>
                    </TableCell>
                    <TableCell>{loan.nextPaymentDate ? formatDate(loan.nextPaymentDate.toISOString()) : "-"}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </DataPanel>
    </div>
  )
}
