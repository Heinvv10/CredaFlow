import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { AccountingExportPanel } from "@/components/accounting/AccountingExportPanel"
import { AccountMappingEditor } from "@/components/accounting/AccountMappingEditor"
import { hasMinRole, requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { nextPeriodKey, periodKeyOf, parsePeriodKey } from "@/lib/accounting/period"

export const metadata = { title: "Accounting export — Reports" }

export default async function AccountingExportPage() {
  // Book-level money figures: the same gate as the other reports. Closing a
  // month, editing the mapping and pushing to Xero need ADMIN (the APIs check).
  const user = await requireMinRole("LOAN_ADMIN")
  const tenantId = await getStaffTenantId()
  const [latest, xero] = await Promise.all([
    prisma.accountingExportBatch.findFirst({ where: { tenantId }, orderBy: { periodStart: "desc" }, select: { periodKey: true } }),
    prisma.xeroConnection.findUnique({ where: { tenantId }, select: { status: true } }),
  ])
  // Open on the next month to close, or last month when nothing is closed yet.
  const lastMonth = periodKeyOf(new Date(parsePeriodKey(periodKeyOf(new Date()))!.start.getTime() - 1))
  const initialPeriod = latest ? nextPeriodKey(latest.periodKey) : lastMonth
  const canAdmin = hasMinRole(user.role, "ADMIN")

  return (
    <div className="space-y-6 px-4 py-5 lg:px-8 lg:py-7">
      <div className="border-b border-[var(--cf-border-subtle)] pb-5">
        <Breadcrumbs className="mb-3" items={[{ label: "Reports", href: "/reports" }, { label: "Accounting export" }]} />
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">General ledger</p>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--cf-text)]">Accounting Export</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--cf-text-muted)]">
          Double-entry journals for disbursements, instalments due (interest, fees, credit-life premiums), default charges, receipts,
          reversals, refunds, waivers and write-offs, one month at a time. Each money event is exported once; a closed month never changes.
        </p>
      </div>
      <AccountingExportPanel initialPeriod={initialPeriod} canClose={canAdmin} xeroConnected={xero?.status === "CONNECTED"} />
      <AccountMappingEditor canEdit={canAdmin} />
    </div>
  )
}
