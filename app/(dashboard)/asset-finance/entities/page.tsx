import Link from "next/link"
import { Building2, Plus } from "lucide-react"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { prisma } from "@/lib/prisma"
import { formatDate } from "@/lib/utils"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { ENTITY_TYPE_LABELS } from "@/lib/asset-finance/labels"

export default async function EntitiesPage() {
  const { tenantId, canManage } = await requireAssetFinanceStaffPage()
  const entities = await prisma.businessEntity.findMany({
    where: { tenantId },
    orderBy: { legalName: "asc" },
    select: {
      id: true,
      type: true,
      legalName: true,
      tradingName: true,
      registrationNumber: true,
      createdAt: true,
      _count: { select: { relationships: { where: { active: true } }, documents: { where: { deletedAt: null } } } },
    },
  })

  const newButton = canManage ? (
    <Button asChild size="sm">
      <Link href="/asset-finance/entities/new">
        <Plus className="h-3.5 w-3.5" />
        New entity
      </Link>
    </Button>
  ) : null

  return (
    <>
      <Header
        title="Business entities"
        subtitle="Companies, close corporations, trusts and partnerships that borrow on asset finance"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Entities" }]}
        actions={newButton}
      />
      <div className="p-4 lg:p-8">
        {entities.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No business entities yet"
            description="Capture a company or trust before you structure a deal for it."
            action={canManage ? { label: "New entity", href: "/asset-finance/entities/new" } : undefined}
          />
        ) : (
          <DataPanel title={`${entities.length} ${entities.length === 1 ? "entity" : "entities"}`} density="compact">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Legal name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Registration</TableHead>
                  <TableHead className="text-right">Active people</TableHead>
                  <TableHead className="text-right">Documents</TableHead>
                  <TableHead>Captured</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entities.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <Link href={`/asset-finance/entities/${e.id}`} className="font-medium text-[var(--cf-brand)] hover:underline">
                        {e.legalName}
                      </Link>
                      {e.tradingName && <p className="text-xs text-[var(--cf-text-muted)]">t/a {e.tradingName}</p>}
                    </TableCell>
                    <TableCell>{ENTITY_TYPE_LABELS[e.type]}</TableCell>
                    <TableCell className="font-mono text-xs">{e.registrationNumber}</TableCell>
                    <TableCell className="text-right">{e._count.relationships}</TableCell>
                    <TableCell className="text-right">{e._count.documents}</TableCell>
                    <TableCell>{formatDate(e.createdAt)}</TableCell>
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
