import Link from "next/link"
import { DealerPageTitle } from "@/components/dealer/DealerShell"
import { DEALER_STATUS_TONE } from "@/components/dealer/dealer-labels"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requireDealerPage } from "@/lib/dealer/page-guard"
import { listDealerDeals } from "@/lib/dealer/deal-view"
import { contractTypeLabel } from "@/lib/asset-finance/deal-labels"
import { formatDate } from "@/lib/utils"

export const dynamic = "force-dynamic"

// The dealer's own deals, newest first (lib/dealer/deal-view.ts).
export default async function DealerDealsPage() {
  const actor = await requireDealerPage()
  const deals = await listDealerDeals(actor)
  return (
    <>
      <DealerPageTitle
        title="Deals"
        subtitle="The finance deals your team has captured for this lender."
        actions={
          <Link href="/dealer/deals/new" className="rounded-md bg-[var(--cf-brand)] px-4 py-2 text-sm font-semibold text-[var(--cf-on-brand)] hover:bg-[var(--cf-brand-alt)]">
            New deal
          </Link>
        }
      />
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Borrower</TableHead>
              <TableHead>Asset</TableHead>
              <TableHead>Agreement</TableHead>
              <TableHead>Captured</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deals.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center text-[var(--cf-text-muted)]">No deals yet. Start one with New deal.</TableCell></TableRow>
            ) : deals.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Link href={`/dealer/deals/${d.id}`} className="font-medium text-[var(--cf-brand-alt)] hover:underline">{d.reference}</Link>
                </TableCell>
                <TableCell>{d.borrower}</TableCell>
                <TableCell>{d.asset.year} {d.asset.make} {d.asset.model}</TableCell>
                <TableCell>{contractTypeLabel(d.contractType)}</TableCell>
                <TableCell>{formatDate(d.createdAt)}</TableCell>
                <TableCell><StatusPill tone={DEALER_STATUS_TONE[d.status]}>{d.status}</StatusPill></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  )
}
