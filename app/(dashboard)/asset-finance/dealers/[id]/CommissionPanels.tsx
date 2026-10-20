import Link from "next/link"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { LINE_KIND_LABELS, REVERSAL_REASON_LABELS, RUN_STATUS_LABELS, RUN_STATUS_TONE, bpsPercent } from "@/lib/dealer/staff-labels"
import type { StaffDealerDetail } from "@/lib/dealer/staff-view"

/** The dealer's commission lines (written only by the database) and its payable runs. */
export function CommissionPanels({ dealer, children }: { dealer: StaffDealerDetail; children?: React.ReactNode }) {
  return (
    <>
      <DataPanel title="Commission lines" description="Earned when a deal is booked; clawed back (exact negatives) when the contract unwinds inside the window" density="compact">
        {dealer.commissionLines.length === 0 ? (
          <p className="p-3 text-sm text-[var(--cf-text-muted)]">No commission yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead><TableHead>Deal</TableHead><TableHead>Line</TableHead><TableHead>Rate</TableHead>
                <TableHead className="text-right">Net</TableHead><TableHead className="text-right">VAT</TableHead>
                <TableHead className="text-right">Gross</TableHead><TableHead>Run</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dealer.commissionLines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{formatIsoDate(l.effectiveOn)}</TableCell>
                  <TableCell>
                    <Link href={`/asset-finance/deals/${l.deal.id}`} className="text-[var(--cf-brand)] hover:underline">{l.deal.application.reference}</Link>
                    <span className="ml-1 text-xs text-[var(--cf-text-muted)]">{l.loan.reference}</span>
                  </TableCell>
                  <TableCell>{LINE_KIND_LABELS[l.kind]}{l.reason && ` (${REVERSAL_REASON_LABELS[l.reason]})`}</TableCell>
                  <TableCell className="text-xs">{bpsPercent(l.bps)} of {formatMoney(l.baseCents)} + {formatMoney(l.flatCents)}</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(l.netCents)}</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(l.vatCents)}</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(l.grossCents)}</TableCell>
                  <TableCell>
                    {l.runId ? <Link href={`/asset-finance/dealer-runs/${l.runId}`} className="text-[var(--cf-brand)] hover:underline">View</Link> : "Unpaid"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataPanel>

      <DataPanel title="Payable runs" description="Created by one user, approved by another, recorded as paid with the lender's EFT reference" density="loose">
        <div className="space-y-4">
          {dealer.payableRuns.length === 0 ? (
            <p className="text-sm text-[var(--cf-text-muted)]">No runs yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {dealer.payableRuns.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3">
                  <Link href={`/asset-finance/dealer-runs/${r.id}`} className="font-medium text-[var(--cf-brand)] hover:underline">
                    Period to {formatIsoDate(r.periodEnd)}
                  </Link>
                  <StatusPill tone={RUN_STATUS_TONE[r.status]}>{RUN_STATUS_LABELS[r.status]}</StatusPill>
                  <span className="font-mono">{formatMoney(r.totalGrossCents)}</span>
                  <span className="text-xs text-[var(--cf-text-muted)]">net {formatMoney(r.totalNetCents)} + VAT {formatMoney(r.totalVatCents)}</span>
                </li>
              ))}
            </ul>
          )}
          {children}
        </div>
      </DataPanel>
    </>
  )
}
