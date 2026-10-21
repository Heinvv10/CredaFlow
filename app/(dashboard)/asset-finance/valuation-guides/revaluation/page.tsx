import Link from "next/link"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { contractTypeLabel } from "@/lib/asset-finance/deal-labels"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { formatLtv } from "@/lib/valuation-guides/ltv"
import { loadRevaluation } from "@/lib/valuation-guides/revaluation-store"
import type { RevaluationMatch } from "@/lib/valuation-guides/revaluation"

const signed = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${formatMoney(Math.abs(cents))}`

function MatchCells({ match, assetId }: { match: RevaluationMatch; assetId: string }) {
  if (match.kind === "none") {
    return <TableCell colSpan={5} className="text-sm text-[var(--cf-text-muted)]">No current guide row for this make, model and year</TableCell>
  }
  if (match.kind === "ambiguous") {
    return (
      <TableCell colSpan={5} className="text-sm text-[var(--cf-text-muted)]">
        {match.count} variants match: <Link href={`/asset-finance/assets/${assetId}`} className="text-[var(--cf-brand)] hover:underline">record the asset&apos;s guide value</Link> to choose one
      </TableCell>
    )
  }
  const { row } = match
  return (
    <>
      <TableCell>
        {row.guideName} · {formatIsoDate(row.effectiveOn)}{row.variant ? ` · ${row.variant}` : ""}
        {row.simulated && <span className="ml-2"><StatusPill tone="warning">Simulated</StatusPill></span>}
      </TableCell>
      <TableCell className="text-right font-mono">{formatMoney(row.tradeCents)}</TableCell>
      <TableCell className="text-right font-mono">{formatMoney(row.retailCents)}</TableCell>
      <TableCell className="text-right font-mono">{match.changeCents === null ? "—" : signed(match.changeCents)}</TableCell>
      <TableCell className="text-right font-mono">{formatLtv(match.ltvBps)}</TableCell>
    </>
  )
}

/**
 * The book revaluation (docs/asset-finance/SLICE5.md part C): each live
 * asset-finance loan's asset against the current guides. It reads only; a
 * dated guide value is recorded on the asset or deal page. LTV is the
 * outstanding principal (no interest, fees or arrears) over the trade value,
 * for instalment sales only (a lease's balance is its remaining rentals, not
 * capital). Unbounded: every live loan on one page.
 */
export default async function RevaluationPage() {
  const { tenantId } = await requireAssetFinanceStaffPage()
  const rows = await loadRevaluation(tenantId)

  return (
    <>
      <Header
        title="Book revaluation"
        subtitle="Live asset-finance loans against the current valuation guides. Guide values are references, not independent valuations"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Valuation guides", href: "/asset-finance/valuation-guides" }, { label: "Book revaluation" }]}
      />
      <div className="space-y-6 p-4 lg:p-8">
        <DataPanel title="Loans" description="Change: trade value now less trade value at the asset's last recorded guide value. LTV (trade): outstanding principal over trade, instalment sales only" density="compact">
          {rows.length === 0 ? (
            <p className="text-sm text-[var(--cf-text-muted)]">No live asset-finance loans.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Loan</TableHead>
                  <TableHead>Asset</TableHead>
                  <TableHead className="text-right">Outstanding principal</TableHead>
                  <TableHead>Guide row</TableHead>
                  <TableHead className="text-right">Trade</TableHead>
                  <TableHead className="text-right">Retail</TableHead>
                  <TableHead className="text-right">Change</TableHead>
                  <TableHead className="text-right">LTV (trade)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.loanId}>
                    <TableCell>
                      <Link href={`/loans/${r.loanId}`} className="text-[var(--cf-brand)] hover:underline">{r.reference}</Link>
                      <span className="block text-xs text-[var(--cf-text-muted)]">{contractTypeLabel(r.contractType)}</span>
                    </TableCell>
                    <TableCell>
                      <Link href={`/asset-finance/assets/${r.asset.id}`} className="text-[var(--cf-brand)] hover:underline">{r.asset.year} {r.asset.make} {r.asset.model}</Link>
                      <span className="block font-mono text-xs text-[var(--cf-text-muted)]">{r.asset.serialNumber}</span>
                    </TableCell>
                    <TableCell className="text-right font-mono">{formatMoney(r.outstandingCents)}</TableCell>
                    <MatchCells match={r.match} assetId={r.asset.id} />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DataPanel>
      </div>
    </>
  )
}
