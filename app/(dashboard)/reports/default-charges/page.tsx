import Link from "next/link"
import { Fragment } from "react"
import { Receipt } from "lucide-react"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { formatDate, formatZAR } from "@/lib/utils"
import { sastMonthKey } from "@/lib/reports/default-charges"
import { loadDefaultChargesReport, loadInDuplumSnapshot } from "@/lib/reports/default-charges-loader"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const monthLabel = (key: string) => `${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`
const DAY_MS = 86_400_000

export default async function DefaultChargesReportPage() {
  // Book-level money figures and client names: the same gate as the reports overview.
  await requireMinRole("LOAN_ADMIN")
  const tenantId = await getStaffTenantId()
  const now = new Date()
  const report = await loadDefaultChargesReport(prisma, tenantId, now)
  // A replay per loan in default: only worth running while charges accrue.
  const inDuplum = report.state === "live" ? await loadInDuplumSnapshot(prisma, tenantId, now) : []
  const thisMonth = report.months.find((m) => m.month === sastMonthKey(now))
  const refundTotal = report.refundsDue.reduce((sum, r) => sum + r.amount, 0)
  const exemptionRefunds = report.refundsDue.filter((r) => r.source === "exemption")
  const newestFirst = [...report.months].reverse()

  return (
    <div className="space-y-6 px-4 py-5 lg:px-8 lg:py-7">
      <div className="border-b border-[var(--cf-border-subtle)] pb-5">
        <Breadcrumbs className="mb-3" items={[{ label: "Reports", href: "/reports" }, { label: "Default charges" }]} />
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">Portfolio Risk</p>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--cf-text)]">Default Charges Report</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--cf-text-muted)]">
          Default interest, post-default service fees and collection letter fees: accrued, collected, waived and still owed, by month and product.
        </p>
      </div>

      {report.state === "stopped" && report.stoppedAt && (
        <div className="rounded-md border border-[var(--cf-warning)] px-4 py-3 text-sm text-[var(--cf-text)]">
          Charges stopped on {formatDate(report.stoppedAt.toISOString())}; unpaid charges are not collected.
        </div>
      )}

      {report.state === "never" ? (
        <DataPanel>
          <EmptyState
            icon={Receipt}
            title="Default charges are not live for this tenant"
            description="Nothing has been charged. Refunds due from over-payments are listed below."
          />
        </DataPanel>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Accrued this month" value={formatZAR(thisMonth?.accrued ?? 0)} />
            <MetricCard label="Collected this month" value={formatZAR(thisMonth?.collected ?? 0)} detail="Cash only; waivers shown separately" />
            <MetricCard label="Outstanding" value={formatZAR(thisMonth?.outstanding ?? 0)} tone="warning" />
            <MetricCard
              label="Charges to refund"
              value={formatZAR(exemptionRefunds.reduce((sum, r) => sum + r.amount, 0))}
              detail={`${exemptionRefunds.length} after exemptions; ${formatZAR(refundTotal)} refunds due in all`}
            />
          </div>

          <DataPanel title="By month and product" description="Months in South African time. Outstanding is at the end of the month (to date for this month).">
            {report.rows.length === 0 ? (
              <EmptyState icon={Receipt} title="No default charges yet" description="No loan has been charged since go-live." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Default interest</TableHead>
                    <TableHead className="text-right">Service fees</TableHead>
                    <TableHead className="text-right">Letter fees</TableHead>
                    <TableHead className="text-right">Accrued</TableHead>
                    <TableHead className="text-right">Collected</TableHead>
                    <TableHead className="text-right">Waived</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead className="text-right">Exemptions set / lifted</TableHead>
                    <TableHead className="text-right">Moved to refund-due</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {newestFirst.map((total) => (
                    <Fragment key={total.month}>
                      {report.rows.filter((r) => r.month === total.month).map((r) => (
                        <TableRow key={`${r.month}-${r.productId}`}>
                          <TableCell>{monthLabel(r.month)}</TableCell>
                          <TableCell>{r.productName}</TableCell>
                          <TableCell className="text-right">{formatZAR(r.interest)}</TableCell>
                          <TableCell className="text-right">{formatZAR(r.fees)}</TableCell>
                          <TableCell className="text-right">{formatZAR(r.letters)}</TableCell>
                          <TableCell className="text-right font-medium">{formatZAR(r.accrued)}</TableCell>
                          <TableCell className="text-right">{formatZAR(r.collected)}</TableCell>
                          <TableCell className="text-right">{formatZAR(r.waived)}</TableCell>
                          <TableCell className="text-right font-medium">{formatZAR(r.outstanding)}</TableCell>
                          <TableCell className="text-right">{r.exemptionsSet} / {r.exemptionsLifted}</TableCell>
                          <TableCell className="text-right">{formatZAR(r.refundDue)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-[var(--cf-surface-soft)] font-semibold">
                        <TableCell>{monthLabel(total.month)}</TableCell>
                        <TableCell>All products</TableCell>
                        <TableCell className="text-right">{formatZAR(total.interest)}</TableCell>
                        <TableCell className="text-right">{formatZAR(total.fees)}</TableCell>
                        <TableCell className="text-right">{formatZAR(total.letters)}</TableCell>
                        <TableCell className="text-right">{formatZAR(total.accrued)}</TableCell>
                        <TableCell className="text-right">{formatZAR(total.collected)}</TableCell>
                        <TableCell className="text-right">{formatZAR(total.waived)}</TableCell>
                        <TableCell className="text-right">{formatZAR(total.outstanding)}</TableCell>
                        <TableCell className="text-right">{total.exemptionsSet} / {total.exemptionsLifted}</TableCell>
                        <TableCell className="text-right">{formatZAR(total.refundDue)}</TableCell>
                      </TableRow>
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            )}
          </DataPanel>

          {report.state === "live" && (
          <DataPanel title="At the in duplum cap" description="Loans whose current default has reached the s103(5) cap: nothing more accrues until the default ends. Used counts the default charges plus the contractual interest, fees and credit-life premiums of the instalments due from the day this default began, as on the loan page. As at today.">
            {inDuplum.length === 0 ? (
              <EmptyState icon={Receipt} title="No loan is at the cap" description="Every loan in default can still accrue charges." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Cap (unpaid principal at default)</TableHead>
                    <TableHead className="text-right">Used</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inDuplum.map((r) => (
                    <TableRow key={r.loanId}>
                      <TableCell>
                        <Link href={`/loans/${r.loanId}`} className="font-medium text-[var(--cf-text)] hover:text-[var(--cf-brand-soft)]">{r.clientName}</Link>
                        <p className="text-[11px] text-[var(--cf-text-muted)]">{r.loanReference}</p>
                      </TableCell>
                      <TableCell>{r.productName}</TableCell>
                      <TableCell className="text-right">{formatZAR(r.capBase)}</TableCell>
                      <TableCell className="text-right">{formatZAR(Math.round(r.accrued))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </DataPanel>
          )}
        </>
      )}

      <DataPanel title="Refunds due" description="Money owed back to clients and not yet refunded: charges removed by an exemption, or receipts beyond what the loan owed.">
        {report.refundsDue.length === 0 ? (
          <EmptyState icon={Receipt} title="No refunds due" description="No client is owed money back." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Due since</TableHead>
                <TableHead className="text-right">Days waiting</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.refundsDue.map((r) => (
                <TableRow key={r.paymentId}>
                  <TableCell>
                    <Link href={`/loans/${r.loanId}`} className="font-medium text-[var(--cf-text)] hover:text-[var(--cf-brand-soft)]">{r.clientName}</Link>
                    <p className="text-[11px] text-[var(--cf-text-muted)]">{r.loanReference}</p>
                  </TableCell>
                  <TableCell>{r.source === "exemption" ? "Charges exemption" : "Over-payment"}</TableCell>
                  <TableCell>{formatDate(r.dueSince.toISOString())}</TableCell>
                  <TableCell className="text-right">{Math.max(0, Math.floor((now.getTime() - r.dueSince.getTime()) / DAY_MS))}</TableCell>
                  <TableCell className="text-right font-medium">{formatZAR(r.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataPanel>

      <p className="text-xs text-[var(--cf-text-muted)]">
        Figures are as currently derived: charges and receipt splits are recalculated on every payment and nightly, so a reversal or an exemption can change earlier months.
        Loans of every status are included; written-off loans keep what they owed at write-off.
      </p>
    </div>
  )
}
