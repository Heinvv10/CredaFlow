import Link from "next/link"
import { notFound } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDateTime } from "@/lib/utils"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { supplierBankAccountView } from "@/lib/asset-finance/supplier-bank-view"
import { requireDealerStaffPage } from "@/lib/dealer/staff-page"
import { loadRunStatement } from "@/lib/dealer/staff-view"
import { LINE_KIND_LABELS, REVERSAL_REASON_LABELS, RUN_STATUS_LABELS, RUN_STATUS_TONE } from "@/lib/dealer/staff-labels"
import { RunActions } from "./RunActions"

const person = (p: { name: string | null; email: string } | null) => (p ? (p.name ?? p.email) : "—")

/** A payable run's statement: what is paid to which account, and who created, approved and released it. */
export default async function DealerRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { user, tenantId, canDecide } = await requireDealerStaffPage()
  const run = await loadRunStatement(tenantId, (await params).runId)
  if (!run) notFound()
  const account = supplierBankAccountView(run.bankAccount, user.role)
  const live = run.lines.filter((l) => !l.voided)

  return (
    <>
      <Header
        title={`${run.dealer.name} · period to ${formatIsoDate(run.periodEnd)}`}
        subtitle="Dealer commission payable run"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Dealers", href: "/asset-finance/dealers" },
          { label: run.dealer.name, href: `/asset-finance/dealers/${run.dealer.id}` }, { label: `Run to ${formatIsoDate(run.periodEnd)}` }]}
        actions={<StatusPill tone={RUN_STATUS_TONE[run.status]}>{RUN_STATUS_LABELS[run.status]}</StatusPill>}
      />
      <div className="space-y-6 p-4 lg:p-8">
        <DataPanel title="Statement" density="loose">
          <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-3">
            {([
              ["Pay to", `${account.accountHolder} · ${account.bankName} ${account.branchCode} · ${account.accountNumber}`],
              ["Account status", account.status === "APPROVED" ? "Approved" : `${account.status} — cancel and create a new run`],
              ["Dealer VAT", run.dealer.vatVendor ? `Vendor ${run.dealer.vatNumber}` : "Not a VAT vendor"],
              ["Net", formatMoney(run.totalNetCents)], ["VAT", formatMoney(run.totalVatCents)], ["Total", formatMoney(run.totalGrossCents)],
              ["Created", `${person(run.createdBy)} · ${formatDateTime(run.createdAt)}`],
              ["Approved", run.approvedAt ? `${person(run.approvedBy)} · ${formatDateTime(run.approvedAt)}` : "—"],
              ["Paid", run.releasedAt ? `${person(run.releasedBy)} · ${formatDateTime(run.releasedAt)} · ref ${run.releaseReference}` : "—"],
              ...(run.cancelledAt ? [["Cancelled", `${person(run.cancelledBy)} · ${formatDateTime(run.cancelledAt)}`] as const] : []),
            ] as const).map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
                <dd className="mt-0.5 text-[var(--cf-text)]">{value}</dd>
              </div>
            ))}
          </dl>
          {canDecide && (
            <div className="mt-4">
              <RunActions runId={run.id} status={run.status} canApprove={run.createdById !== user.id} />
            </div>
          )}
        </DataPanel>

        <DataPanel title={`${live.length} ${live.length === 1 ? "line" : "lines"}`} description={run.status === "CANCELLED" ? "Cancelled: these lines were freed for a later run" : undefined} density="compact">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead><TableHead>Deal</TableHead><TableHead>Line</TableHead>
                <TableHead className="text-right">Net</TableHead><TableHead className="text-right">VAT</TableHead><TableHead className="text-right">Gross</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(run.status === "CANCELLED" ? run.lines : live).map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{formatIsoDate(l.effectiveOn)}</TableCell>
                  <TableCell>
                    <Link href={`/asset-finance/deals/${l.deal.id}`} className="text-[var(--cf-brand)] hover:underline">{l.deal.application.reference}</Link>
                    <span className="ml-1 text-xs text-[var(--cf-text-muted)]">{l.loan.reference}</span>
                  </TableCell>
                  <TableCell>{LINE_KIND_LABELS[l.kind]}{l.reason && ` (${REVERSAL_REASON_LABELS[l.reason]})`}</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(l.netCents)}</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(l.vatCents)}</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(l.grossCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataPanel>
      </div>
    </>
  )
}
