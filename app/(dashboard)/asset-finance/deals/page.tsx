import Link from "next/link"
import { FileText, Plus } from "lucide-react"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate } from "@/lib/utils"
import { formatMoney } from "@/lib/asset-finance/format"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { loadDealList } from "@/lib/asset-finance/deal-detail"
import { DEAL_STATUS_TONE, contractTypeLabel, dealStatusLabel } from "@/lib/asset-finance/deal-labels"

export default async function DealsPage() {
  const { tenantId, canManage } = await requireAssetFinanceStaffPage()
  const deals = await loadDealList(tenantId)

  const newButton = canManage ? (
    <Button asChild size="sm">
      <Link href="/asset-finance/deals/new">
        <Plus className="h-3.5 w-3.5" />
        New deal
      </Link>
    </Button>
  ) : null

  return (
    <>
      <Header
        title="Deals"
        subtitle="Instalment sales, finance leases, operating and full-maintenance leases for business entities and sole proprietors"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Deals" }]}
        actions={newButton}
      />
      <div className="p-4 lg:p-8">
        {deals.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No deals yet"
            description="Structure a deal on a registered asset for an onboarded entity or sole proprietor."
            action={canManage ? { label: "New deal", href: "/asset-finance/deals/new" } : undefined}
          />
        ) : (
          <DataPanel title={`${deals.length} ${deals.length === 1 ? "deal" : "deals"}`} density="compact">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Agreement</TableHead>
                  <TableHead>Borrower / lessee</TableHead>
                  <TableHead>Asset</TableHead>
                  <TableHead className="text-right">Financed / capital</TableHead>
                  <TableHead className="text-right">Instalment / rental</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deals.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Link href={`/asset-finance/deals/${d.id}`} className="font-medium text-[var(--cf-brand)] hover:underline">
                        {d.applicationReference}
                      </Link>
                    </TableCell>
                    <TableCell>{contractTypeLabel(d.contractType)}</TableCell>
                    <TableCell>{d.entityName}</TableCell>
                    <TableCell>{d.assetDescription}</TableCell>
                    <TableCell className="text-right">{formatMoney(d.financedAmountCents)}</TableCell>
                    <TableCell className="text-right">{d.baseInstalmentCents === null ? "—" : formatMoney(d.baseInstalmentCents)}</TableCell>
                    <TableCell>
                      <StatusPill tone={DEAL_STATUS_TONE[d.status]}>{dealStatusLabel(d.status)}</StatusPill>
                    </TableCell>
                    <TableCell>{formatDate(d.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataPanel>
        )}
      </div>
    </>
  )
}
