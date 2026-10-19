import { notFound } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { prisma } from "@/lib/prisma"
import { formatDate, formatDateTime } from "@/lib/utils"
import { sastCalendarDate } from "@/lib/date/sast"
import { requireDealerStaffPage } from "@/lib/dealer/staff-page"
import { loadDealerForStaff } from "@/lib/dealer/staff-view"
import { latestPeriodEnd } from "@/lib/dealer/payable-runs"
import { DEALER_KIND_LABELS, DEALER_ROLE_LABELS } from "@/lib/dealer/staff-labels"
import { RateForm } from "../RateForm"
import { RateHistory } from "../RateHistory"
import { BankAccountsPanel } from "./BankAccountsPanel"
import { CommissionPanels } from "./CommissionPanels"
import { CreateRunForm } from "./CreateRunForm"
import { DeactivateDealerButton } from "./DeactivateDealerButton"
import { DealerUserActions } from "./DealerUserActions"
import { DealerUserForm } from "./DealerUserForm"

export default async function DealerPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, tenantId, canDecide } = await requireDealerStaffPage()
  const { id } = await params
  const dealer = await loadDealerForStaff(tenantId, id)
  if (!dealer) notFound()

  const staffIds = [...new Set(dealer.bankAccounts.flatMap((a) => [a.requestedById, a.decidedById]).filter((v): v is string => !!v))]
  const staff = await prisma.user.findMany({ where: { tenantId, id: { in: staffIds } }, select: { id: true, name: true, email: true } })
  const who = (userId: string | null) => {
    const found = userId ? staff.find((s) => s.id === userId) : undefined
    return userId ? (found ? (found.name ?? found.email) : "Unknown user") : "—"
  }
  const today = sastCalendarDate(new Date())

  return (
    <>
      <Header
        title={dealer.name}
        subtitle={`${DEALER_KIND_LABELS[dealer.kind]} · registered ${formatDate(dealer.createdAt)}`}
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Dealers", href: "/asset-finance/dealers" }, { label: dealer.name }]}
        actions={
          <div className="flex items-center gap-3">
            <StatusPill tone={dealer.active ? "success" : "neutral"}>{dealer.active ? "Active" : "Deactivated"}</StatusPill>
            {dealer.active && <DeactivateDealerButton dealerId={dealer.id} />}
          </div>
        }
      />
      <div className="space-y-6 p-4 lg:p-8">
        <DataPanel title="Dealer" density="loose">
          <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-3">
            {([
              ["Registration number", dealer.registrationNumber],
              ["VAT", dealer.vatVendor ? `Vendor ${dealer.vatNumber}` : "Not a VAT vendor (commission carries no VAT)"],
              ["Default supplier", dealer.supplier?.name ?? null],
              ["Email", dealer.contactEmail],
              ["Phone", dealer.contactPhone],
              ["Deactivated", dealer.deactivatedAt ? formatDateTime(dealer.deactivatedAt) : null],
            ] as const).map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
                <dd className="mt-0.5 text-[var(--cf-text)]">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </DataPanel>

        <DataPanel title="Users" description="Password sign-in on the dealer host; every change ends the user's sessions" density="loose">
          <div className="space-y-4">
            {dealer.users.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Role</TableHead>
                    <TableHead>Sign-in</TableHead><TableHead>Last sign-in</TableHead><TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dealer.users.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>{u.name}</TableCell>
                      <TableCell className="font-mono text-xs">{u.email}</TableCell>
                      <TableCell>{DEALER_ROLE_LABELS[u.role]}</TableCell>
                      <TableCell className="text-xs">
                        {!u.active ? "Deactivated" : u.linkPendingUntil ? `Link pending until ${formatDateTime(u.linkPendingUntil)}` : u.passwordSet ? "Password set" : "No password: issue a link"}
                      </TableCell>
                      <TableCell className="text-xs">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "—"}</TableCell>
                      <TableCell>{u.active && dealer.active && <DealerUserActions dealerId={dealer.id} userId={u.id} />}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {dealer.active && <DealerUserForm dealerId={dealer.id} first={!dealer.users.some((u) => u.active)} />}
          </div>
        </DataPanel>

        <DataPanel title="Commission rate" description="The dealer's own rate; without one, the lender's default applies" density="loose">
          <div className="space-y-4">
            <RateHistory rows={dealer.commissionRates} today={today} />
            {dealer.active && <RateForm url={`/api/asset-finance/dealers/${dealer.id}/rates`} label="New rate for this dealer" />}
          </div>
        </DataPanel>

        <BankAccountsPanel dealer={dealer} user={user} canDecide={canDecide} who={who} />

        <CommissionPanels dealer={dealer}>
          <CreateRunForm dealerId={dealer.id} defaultPeriodEnd={latestPeriodEnd(today)} />
        </CommissionPanels>
      </div>
    </>
  )
}
