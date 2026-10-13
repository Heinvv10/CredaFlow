import { KpiCard } from "@/components/dashboard/KpiCard"
import { DisbursementsClient } from "@/components/disbursements/DisbursementsClient"
import { prisma } from "@/lib/prisma"
import { formatZAR, SAST_TIME_ZONE } from "@/lib/utils"
import { getAvatarColor, getInitials } from "@/lib/avatar"
import { Wallet, CheckCircle2, TrendingUp } from "lucide-react"
import Link from "next/link"
import { getStaffTenantId } from "@/lib/session-tenant"
import { sastMonthBounds } from "@/lib/compliance/quarters"
import { sastStartOfDay } from "@/lib/date/sast"
import { requireMinRole } from "@/lib/auth-guards"

async function getDisbursementsData() {
  const tenantId = await getStaffTenantId()
  const now = new Date()
  // SAST boundary: the container has no TZ, so date parts resolve in UTC and
  // land two hours inside the previous South African day.
  const monthStart = sastMonthBounds(now).start
  const todayStart = sastStartOfDay(now)

  const [
    readyToDisburse,
    disbursedToday,
    disbursedThisMonth,
    recentDisbursements,
  ] = await Promise.all([
    prisma.loanApplication.findMany({
      // Both agreement signatures are universal. Debit-order applications
      // additionally need their mandate; EFT applications use verified payout
      // banking in the disbursement route and have no mandate ceremony.
      where: {
        tenantId,
        status: "APPROVED",
        agreementSignedAt: { not: null },
        agreementCountersignedAt: { not: null },
        OR: [
          { repaymentMethod: "EFT" },
          {
            repaymentMethod: "DEBIT_ORDER",
            debitMandateSignedAt: { not: null },
          },
        ],
      },
      include: {
        client: { select: { firstName: true, lastName: true } },
        product: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.loan.aggregate({
      where: {
        tenantId,
        startDate: { gte: todayStart },
      },
      _sum: { principal: true },
      _count: true,
    }),
    prisma.loan.aggregate({
      where: {
        tenantId,
        startDate: { gte: monthStart },
      },
      _sum: { principal: true },
      _count: true,
    }),
    prisma.loan.findMany({
      where: {
        tenantId,
        startDate: { gte: monthStart },
      },
      take: 10,
      orderBy: { startDate: "desc" },
      include: {
        client: { select: { firstName: true, lastName: true } },
        product: { select: { name: true } },
      },
    }),
  ])

  return {
    readyToDisburse,
    disbursedToday: disbursedToday._sum.principal || 0,
    disbursedTodayCount: disbursedToday._count || 0,
    disbursedThisMonth: disbursedThisMonth._sum.principal || 0,
    disbursedThisMonthCount: disbursedThisMonth._count || 0,
    recentDisbursements,
  }
}

function formatCompactZAR(cents: number): string {
  const val = cents / 100
  if (val >= 1_000_000) return `R${(val / 1_000_000).toFixed(1)}m`
  if (val >= 1_000) return `R${(val / 1_000).toFixed(0)}k`
  return formatZAR(cents)
}

export default async function DisbursementsPage() {
  // Disbursement is a LOAN_ADMIN action (PERMISSIONS.disburse_loan); the API
  // returns 403 below that. Gate the page to match so lower roles don't see
  // disbursement controls they can't action.
  await requireMinRole("LOAN_ADMIN")
  const data = await getDisbursementsData()

  const monthName = new Date().toLocaleDateString("en-ZA", { month: "long", timeZone: SAST_TIME_ZONE })

  return (
    <div className="p-4 lg:p-8 space-y-6">
      {/* Page Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Disbursements</h1>
          <p className="text-sm mt-1" style={{ color: "#666" }}>
            Manage loan disbursements and track funding
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <KpiCard
          title="Ready to Disburse"
          value={data.readyToDisburse.length.toString()}
          subtitle="Agreement complete + repayment setup complete"
          icon={Wallet}
          accentColor="green"
        />
        <KpiCard
          title="Disbursed Today"
          value={formatCompactZAR(data.disbursedToday)}
          subtitle={`${data.disbursedTodayCount} loan${data.disbursedTodayCount !== 1 ? "s" : ""}`}
          icon={CheckCircle2}
          accentColor="gold"
        />
        <KpiCard
          title={`${monthName} Total`}
          value={formatCompactZAR(data.disbursedThisMonth)}
          subtitle={`${data.disbursedThisMonthCount} disbursements`}
          icon={TrendingUp}
          accentColor="blue"
        />
      </div>

      {/* Two-Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Ready to Disburse */}
        <DisbursementsClient applications={data.readyToDisburse} />

        {/* Recent Disbursements */}
        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h3 className="font-semibold text-gray-900">Recent Disbursements</h3>
          </div>
          {data.recentDisbursements.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">No disbursements this month</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: "#FAFAFA" }}>
                  <th className="px-5 py-3 text-left font-semibold uppercase tracking-wider text-[11px]" style={{ color: "#9CA3AF" }}>Client</th>
                  <th className="px-5 py-3 text-left font-semibold uppercase tracking-wider text-[11px]" style={{ color: "#9CA3AF" }}>Product</th>
                  <th className="px-5 py-3 text-left font-semibold uppercase tracking-wider text-[11px]" style={{ color: "#9CA3AF" }}>Amount</th>
                  <th className="px-5 py-3 text-left font-semibold uppercase tracking-wider text-[11px]" style={{ color: "#9CA3AF" }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {data.recentDisbursements.map((loan) => {
                  const initials = getInitials(loan.client.firstName, loan.client.lastName)
                  const avatarColor = getAvatarColor(loan.client.firstName + loan.client.lastName)
                  return (
                    <tr key={loan.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0"
                            style={{ backgroundColor: avatarColor }}
                          >
                            {initials}
                          </div>
                          <Link href={`/loans/${loan.id}`} className="font-medium text-gray-900 hover:underline">
                            {loan.client.firstName} {loan.client.lastName}
                          </Link>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-gray-600">{loan.product.name}</td>
                      <td className="px-5 py-3.5 font-semibold text-gray-900">{formatZAR(loan.principal)}</td>
                      <td className="px-5 py-3.5 text-gray-400">
                        {loan.startDate.toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: SAST_TIME_ZONE })}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
