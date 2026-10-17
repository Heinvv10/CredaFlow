import Link from "next/link"
import { Plus, Tractor } from "lucide-react"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { prisma } from "@/lib/prisma"
import { formatDate } from "@/lib/utils"
import { formatMoney } from "@/lib/asset-finance/format"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { ASSET_CLASS_LABELS, assetBookStatus } from "@/lib/asset-finance/asset-labels"

export default async function AssetsPage() {
  const { tenantId, canManage } = await requireAssetFinanceStaffPage()
  const assets = await prisma.financedAsset.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true, assetClass: true, make: true, model: true, year: true, serialNumber: true, vin: true,
      registrationNumber: true, cashPriceExclVatCents: true, vatCents: true, releasedAt: true, createdAt: true,
      deals: { select: { status: true } },
    },
  })

  const newButton = canManage ? (
    <Button asChild size="sm">
      <Link href="/asset-finance/assets/new">
        <Plus className="h-3.5 w-3.5" />
        Register asset
      </Link>
    </Button>
  ) : null

  return (
    <>
      <Header
        title="Asset register"
        subtitle="Vehicles and machinery financed or about to be financed"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Assets" }]}
        actions={newButton}
      />
      <div className="p-4 lg:p-8">
        {assets.length === 0 ? (
          <EmptyState
            icon={Tractor}
            title="No assets registered yet"
            description="Register the vehicle or machine before you structure a deal on it."
            action={canManage ? { label: "Register asset", href: "/asset-finance/assets/new" } : undefined}
          />
        ) : (
          <DataPanel title={`${assets.length} ${assets.length === 1 ? "asset" : "assets"}`} density="compact">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead>Serial / VIN</TableHead>
                  <TableHead className="text-right">Price incl. VAT</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Registered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assets.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link href={`/asset-finance/assets/${a.id}`} className="font-medium text-[var(--cf-brand)] hover:underline">
                        {a.year} {a.make} {a.model}
                      </Link>
                      {a.registrationNumber && <p className="text-xs text-[var(--cf-text-muted)]">{a.registrationNumber}</p>}
                    </TableCell>
                    <TableCell>{ASSET_CLASS_LABELS[a.assetClass]}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {a.serialNumber}
                      {a.vin && <p className="text-[var(--cf-text-muted)]">{a.vin}</p>}
                    </TableCell>
                    <TableCell className="text-right">{formatMoney(a.cashPriceExclVatCents + a.vatCents)}</TableCell>
                    <TableCell>{assetBookStatus({ releasedAt: a.releasedAt && formatDate(a.releasedAt), deals: a.deals })}</TableCell>
                    <TableCell>{formatDate(a.createdAt)}</TableCell>
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
