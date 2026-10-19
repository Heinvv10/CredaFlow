import Link from "next/link"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { DealerPageTitle } from "@/components/dealer/DealerShell"
import { COMMISSION_KIND_LABELS, RUN_STATUS_LABELS, humanise } from "@/components/dealer/dealer-labels"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requireDealerPage } from "@/lib/dealer/page-guard"
import { loadDealerCommissionStatement } from "@/lib/dealer/commission-statement"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { formatDate } from "@/lib/utils"

export const dynamic = "force-dynamic"

// The dealer's commission statement, read-only: lines earned at booking or
// reversed on clawback, and the lender's payable runs.
export default async function DealerCommissionPage() {
  const actor = await requireDealerPage()
  const { totals, lines, runs } = await loadDealerCommissionStatement(actor)
  return (
    <>
      <DealerPageTitle title="Commission" subtitle="Commission is earned when the lender books a deal; a deal unwound early may reverse it. Amounts include VAT where you are a VAT vendor." />
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Earned (excl. VAT)" value={formatMoney(totals.earnedNetCents)} />
        <MetricCard label="Reversed (excl. VAT)" value={formatMoney(totals.reversedNetCents)} />
        <MetricCard label="Net incl. VAT" value={formatMoney(totals.grossCents)} />
      </div>
      <DataPanel title="Payable runs" className="mb-5">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period end</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Excl. VAT</TableHead>
              <TableHead className="text-right">VAT</TableHead><TableHead className="text-right">Total</TableHead><TableHead>Paid</TableHead><TableHead>Reference</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center text-[var(--cf-text-muted)]">No payable runs yet.</TableCell></TableRow>
            ) : runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{formatIsoDate(r.periodEnd)}</TableCell>
                <TableCell>{RUN_STATUS_LABELS[r.status] ?? humanise(r.status)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(r.totalNetCents)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(r.totalVatCents)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(r.totalGrossCents)}</TableCell>
                <TableCell>{r.releasedAt ? formatDate(r.releasedAt) : "—"}</TableCell>
                <TableCell className="font-mono text-xs">{r.releaseReference ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataPanel>
      <DataPanel title="Commission lines">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead><TableHead>Deal</TableHead><TableHead>Loan</TableHead><TableHead>Line</TableHead>
              <TableHead className="text-right">Excl. VAT</TableHead><TableHead className="text-right">VAT</TableHead><TableHead className="text-right">Total</TableHead><TableHead>Run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center text-[var(--cf-text-muted)]">No commission yet. It is earned when the lender books one of your deals.</TableCell></TableRow>
            ) : lines.map((l) => {
              const run = l.runId ? runs.find((r) => r.id === l.runId) : undefined
              return (
                <TableRow key={l.id}>
                  <TableCell>{formatIsoDate(l.effectiveOn)}</TableCell>
                  <TableCell><Link href={`/dealer/deals/${l.dealId}`} className="text-[var(--cf-brand-alt)] hover:underline">{l.dealReference}</Link></TableCell>
                  <TableCell className="font-mono text-xs">{l.loanReference}</TableCell>
                  <TableCell>{COMMISSION_KIND_LABELS[l.kind]}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.netCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.vatCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.grossCents)}</TableCell>
                  <TableCell>{run ? `${formatIsoDate(run.periodEnd)} · ${RUN_STATUS_LABELS[run.status] ?? humanise(run.status)}` : "Not yet in a run"}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </DataPanel>
    </>
  )
}
