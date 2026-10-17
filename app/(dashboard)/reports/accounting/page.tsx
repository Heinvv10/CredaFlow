import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { AccountingWorkspace } from "@/components/accounting/AccountingWorkspace"
import { hasMinRole, requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { nextPeriodKey, periodKeyOf, parsePeriodKey } from "@/lib/accounting/period"
import Link from "next/link"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { loadDoublePayoutRisks } from "@/lib/payouts/double-payout"

export const metadata = { title: "Accounting export — Reports" }

export default async function AccountingExportPage() {
  // Book-level money figures: the same gate as the other reports. Closing a
  // month, editing the mapping and pushing to Xero or IsaFlow need ADMIN (the APIs check).
  const user = await requireMinRole("LOAN_ADMIN")
  const tenantId = await getStaffTenantId()
  const [latest, xero, isaflow, doubles] = await Promise.all([
    prisma.accountingExportBatch.findFirst({ where: { tenantId }, orderBy: { periodStart: "desc" }, select: { periodKey: true } }),
    prisma.xeroConnection.findUnique({ where: { tenantId }, select: { status: true } }),
    prisma.isaFlowConnection.findUnique({ where: { tenantId }, select: { status: true } }),
    loadDoublePayoutRisks(prisma, tenantId),
  ])
  // Two payouts of one loan that may both have gone out: the books carry one.
  const paidTwice = doubles.filter((d) => d.liveStatus === "PAID")
  // Open on the next month to close: after the last closed one, else the
  // go-live month, else last month.
  const settings = await prisma.accountingSettings.findUnique({ where: { tenantId }, select: { goLiveMonth: true } })
  const lastMonth = periodKeyOf(new Date(parsePeriodKey(periodKeyOf(new Date()))!.start.getTime() - 1))
  const initialPeriod = latest ? nextPeriodKey(latest.periodKey) : settings?.goLiveMonth ?? lastMonth
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
      {paidTwice.length > 0 && (
        <InfoStrip variant="danger">
          Possible double payouts: the provider reports an earlier attempt paid while a later one is paid too. The export books one payout per loan
          until staff resolve it, so the bank may have paid out once more than the export shows. Resolve before closing the month:{" "}
          {paidTwice.map((d, i) => (
            <span key={`${d.payoutId}-${d.liveAttempt}`}>{i > 0 && ", "}<Link href={`/loans/${d.loanId}`} className="underline">{d.reference}</Link></span>
          ))}
        </InfoStrip>
      )}
      <AccountingWorkspace initialPeriod={initialPeriod} canAdmin={canAdmin} locked={latest !== null} xeroConnected={xero?.status === "CONNECTED"} isaflowConnected={isaflow?.status === "CONNECTED"} />
    </div>
  )
}
