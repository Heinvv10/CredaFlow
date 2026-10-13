import Link from "next/link"
import { Plus, Store } from "lucide-react"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { prisma } from "@/lib/prisma"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"

export default async function SuppliersPage() {
  const { tenantId, canManage } = await requireAssetFinanceStaffPage()
  const suppliers = await prisma.supplier.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
    take: 500,
    include: { bankAccounts: { where: { status: { in: ["PENDING", "APPROVED"] } }, select: { status: true } } },
  })

  const newButton = canManage ? (
    <Button asChild size="sm">
      <Link href="/asset-finance/suppliers/new">
        <Plus className="h-3.5 w-3.5" />
        New supplier
      </Link>
    </Button>
  ) : null

  return (
    <>
      <Header
        title="Suppliers"
        subtitle="Dealers and sellers paid out on asset deals; bank accounts need a second approver"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Suppliers" }]}
        actions={newButton}
      />
      <div className="p-4 lg:p-8">
        {suppliers.length === 0 ? (
          <EmptyState
            icon={Store}
            title="No suppliers yet"
            description="Register the dealer or seller before you structure a deal that pays them."
            action={canManage ? { label: "New supplier", href: "/asset-finance/suppliers/new" } : undefined}
          />
        ) : (
          <DataPanel title={`${suppliers.length} ${suppliers.length === 1 ? "supplier" : "suppliers"}`} density="compact">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Registration</TableHead>
                  <TableHead>VAT number</TableHead>
                  <TableHead>Bank account</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {suppliers.map((s) => {
                  const approved = s.bankAccounts.some((a) => a.status === "APPROVED")
                  const pending = s.bankAccounts.filter((a) => a.status === "PENDING").length
                  return (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Link href={`/asset-finance/suppliers/${s.id}`} className="font-medium text-[var(--cf-brand)] hover:underline">
                          {s.name}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{s.registrationNumber ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{s.vatNumber ?? "—"}</TableCell>
                      <TableCell>
                        {approved ? "Approved" : "None approved"}
                        {pending > 0 && <span className="ml-1 text-[var(--cf-warning)]">· {pending} awaiting approval</span>}
                      </TableCell>
                      <TableCell>{s.active ? "Active" : "Inactive"}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </DataPanel>
        )}
      </div>
    </>
  )
}
