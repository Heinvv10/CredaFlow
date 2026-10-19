import Link from "next/link"
import { Handshake } from "lucide-react"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { requireDealerStaffPage } from "@/lib/dealer/staff-page"
import { defaultRateHistory, listDealersForStaff } from "@/lib/dealer/staff-view"
import { DEALER_KIND_LABELS } from "@/lib/dealer/staff-labels"
import { DealerCreateForm } from "./DealerCreateForm"
import { RateForm } from "./RateForm"
import { RateHistory } from "./RateHistory"

export const metadata = { title: "Dealers — Asset Finance" }

export default async function DealersPage() {
  const { tenantId } = await requireDealerStaffPage()
  const [dealers, defaultRates, suppliers, config] = await Promise.all([
    listDealersForStaff(tenantId),
    defaultRateHistory(tenantId),
    prisma.supplier.findMany({ where: { tenantId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { featureDealerPortal: true } }),
  ])
  const today = sastCalendarDate(new Date())

  return (
    <>
      <Header
        title="Dealers"
        subtitle="Dealers and brokers who originate deals through the dealer portal, their commission and its payment"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Dealers" }]}
      />
      <div className="space-y-6 p-4 lg:p-8">
        {!config?.featureDealerPortal && (
          <p className="text-sm text-[var(--cf-warning)]">
            The dealer portal is off for this lender (Settings → Asset Finance): dealers cannot sign in. Earned commission can still be paid.
          </p>
        )}
        <DealerCreateForm suppliers={suppliers} />
        {dealers.length === 0 ? (
          <EmptyState icon={Handshake} title="No dealers yet" description="Register a dealer or broker, then add its first dealer admin." />
        ) : (
          <DataPanel title={`${dealers.length} ${dealers.length === 1 ? "dealer" : "dealers"}`} density="compact">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dealer</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>VAT vendor</TableHead>
                  <TableHead>Active users</TableHead>
                  <TableHead>Bank account</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dealers.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Link href={`/asset-finance/dealers/${d.id}`} className="font-medium text-[var(--cf-brand)] hover:underline">{d.name}</Link>
                    </TableCell>
                    <TableCell>{DEALER_KIND_LABELS[d.kind]}</TableCell>
                    <TableCell>{d.vatVendor ? "Yes" : "No"}</TableCell>
                    <TableCell>{d.activeUsers}</TableCell>
                    <TableCell>
                      {d.hasApprovedAccount ? "Approved" : "None approved"}
                      {d.pendingAccounts > 0 && <span className="ml-1 text-[var(--cf-warning)]">· {d.pendingAccounts} awaiting approval</span>}
                    </TableCell>
                    <TableCell>{d.active ? "Active" : "Deactivated"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataPanel>
        )}
        <DataPanel title="Default commission rate" description="For a dealer with no rate of its own on the approval date" density="loose">
          <div className="space-y-4">
            <RateHistory rows={defaultRates} today={today} />
            <RateForm url="/api/asset-finance/dealer-commission/default-rate" label="New default rate" />
          </div>
        </DataPanel>
      </div>
    </>
  )
}
