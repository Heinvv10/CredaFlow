import { prisma } from "@/lib/prisma"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"
import { formatZAR, formatDate } from "@/lib/utils"
import { Header } from "@/components/layout/Header"
import Link from "next/link"
import { PaymentsClient } from "@/components/payments/PaymentsClient"
import { PeriodPills } from "@/components/payments/PeriodPills"
import { getDefaultTenantId } from "@/lib/tenant"
import {
  type Period,
  periodFilter,
  periodQuery,
  precedingPeriod,
  resolvePeriod,
} from "@/lib/date/sast-period"
import { borrowerDisplayName } from "@/lib/borrower"

/** Rows fetched per tab. The KPI figures are aggregates and ignore this cap. */
const ROW_CAP = 200

async function getData(period: Period, now: Date) {
  const tenantId = await getDefaultTenantId()
  const receivedAt = periodFilter(period)
  const preceding = precedingPeriod(period, now)

  const paymentInclude = {
    loan: {
      select: {
        id: true,
        reference: true,
        outstandingPrincipal: true,
        client: { select: { firstName: true, lastName: true } },
        entity: { select: { legalName: true } },
      },
    },
  } as const

  const [
    allocated,
    allocatedCount,
    outstandingRefunds,
    resolved,
    resolvedCount,
    periodStats,
    allTimeStats,
    unappliedStats,
    precedingStats,
    overdue,
  ] = await Promise.all([
    prisma.payment.findMany({
      where: { tenantId, reversed: false, allocationStatus: "ALLOCATED", receivedAt },
      orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
      take: ROW_CAP,
      include: paymentInclude,
    }),
    // Counted separately from the capped fetch, so the screen can say how much
    // it is NOT showing rather than presenting 200 rows as the whole period.
    prisma.payment.count({
      where: { tenantId, reversed: false, allocationStatus: "ALLOCATED", receivedAt },
    }),
    // Deliberately NOT period-scoped. Unapplied money is a live liability: it
    // is the only record that the lender is holding a client's money without
    // having reduced a balance, and this screen is the only place it can be
    // discharged. A period filter that could hide one would be a filter that
    // loses money, so this tab always shows every outstanding receipt.
    prisma.payment.findMany({
      where: { tenantId, reversed: false, allocationStatus: "UNAPPLIED" },
      orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
      include: paymentInclude,
    }),
    prisma.payment.findMany({
      where: {
        tenantId,
        receivedAt,
        OR: [{ reversed: true }, { allocationStatus: "REFUNDED" }],
      },
      orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
      take: ROW_CAP,
      include: paymentInclude,
    }),
    // Counted for the same reason the allocated list is: this tab is capped
    // too, and a cap with no count cannot tell the reader it is cropped.
    prisma.payment.count({
      where: {
        tenantId,
        receivedAt,
        OR: [{ reversed: true }, { allocationStatus: "REFUNDED" }],
      },
    }),
    prisma.payment.aggregate({
      where: { tenantId, receivedAt, reversed: false, allocationStatus: "ALLOCATED", ...CASH_RECEIPTS },
      _sum: { amount: true }, _count: true,
    }),
    // No date bound, and it does not move when the pills do. Before this the
    // page could only ever show three rolling windows, so a lender whose last
    // receipt was three weeks old saw R 0,00 in every card and no way at all
    // to ask "what have we actually been paid".
    prisma.payment.aggregate({
      where: { tenantId, reversed: false, allocationStatus: "ALLOCATED", ...CASH_RECEIPTS },
      _sum: { amount: true }, _count: true,
    }),
    prisma.payment.aggregate({
      where: { tenantId, reversed: false, allocationStatus: "UNAPPLIED" },
      _sum: { amount: true }, _count: true,
    }),
    preceding
      ? prisma.payment.aggregate({
          where: {
            tenantId,
            receivedAt: periodFilter(preceding),
            reversed: false,
            allocationStatus: "ALLOCATED",
            ...CASH_RECEIPTS,
          },
          _sum: { amount: true }, _count: true,
        })
      : Promise.resolve(null),
    // Overdue schedule items
    prisma.repaymentSchedule.findMany({
      where: { tenantId, status: { in: ["OVERDUE", "PARTIAL"] }, dueDate: { lt: now } },
      orderBy: { dueDate: "asc" },
      take: 50,
      include: {
        loan: {
          select: {
            id: true,
            reference: true,
            daysInArrears: true,
            client: { select: { firstName: true, lastName: true } },
            entity: { select: { legalName: true } },
          },
        },
      },
    }),
  ])

  const money = (agg: { _sum: { amount: number | null }; _count: number }) => ({
    amount: Number(agg._sum.amount || 0),
    count: agg._count,
  })

  return {
    allocated: JSON.parse(JSON.stringify(allocated)),
    allocatedCount,
    unapplied: JSON.parse(JSON.stringify(outstandingRefunds)),
    resolved: JSON.parse(JSON.stringify(resolved)),
    resolvedCount,
    stats: {
      period: money(periodStats),
      allTime: money(allTimeStats),
      unapplied: money(unappliedStats),
      preceding: precedingStats ? money(precedingStats) : null,
      precedingLabel: preceding?.label ?? null,
    },
    overdue: JSON.parse(JSON.stringify(overdue)),
  }
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>
}) {
  const params = await searchParams
  const now = new Date()
  // SAST boundaries, not the container's. The container sets no TZ, so
  // `new Date(y, m, 1)` was UTC midnight — two hours inside the previous South
  // African day. A receipt at 00:32 SAST on the 1st is stored as 22:32Z on the
  // last of the previous month, so the table below (which renders in SAST)
  // showed it in August while this page's month total counted it in July.
  const period = resolvePeriod(params, now)
  const { allocated, allocatedCount, unapplied, resolved, resolvedCount, stats, overdue } =
    await getData(period, now)

  const delta =
    stats.preceding && stats.preceding.amount > 0
      ? Math.round(((stats.period.amount - stats.preceding.amount) / stats.preceding.amount) * 100)
      : null

  return (
    <>
      <Header title="Payments" subtitle="Capture, track and reconcile loan repayments" />
      <div className="p-4 lg:p-8 space-y-6">
        <PeriodPills period={period} />

        {/* KPI strip */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-l-blue-500">
            <p className="text-xs text-gray-500">{period.label}</p>
            <p className="text-2xl font-bold">{formatZAR(stats.period.amount)}</p>
            <p className="text-xs text-gray-400">
              {stats.period.count} payment{stats.period.count === 1 ? "" : "s"}
              {delta !== null && stats.precedingLabel && (
                <span className={delta < 0 ? "text-red-500" : "text-green-600"}>
                  {" · "}{delta > 0 ? "↑" : delta < 0 ? "↓" : ""}{Math.abs(delta)}% vs {stats.precedingLabel}
                </span>
              )}
            </p>
          </div>
          {/* Fixed by design: it does NOT follow the pills. Every figure on this
              page used to be a rolling window, so a lender whose last receipt
              was three weeks old saw R 0,00 everywhere and had no way to ask
              what had been collected in total. */}
          <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-l-green-500">
            <p className="text-xs text-gray-500">All time</p>
            <p className="text-2xl font-bold">{formatZAR(stats.allTime.amount)}</p>
            <p className="text-xs text-gray-400">
              {stats.allTime.count} payment{stats.allTime.count === 1 ? "" : "s"} · not filtered
            </p>
          </div>
          <div className="bg-white rounded-lg shadow-sm p-5 border-l-4 border-l-amber-500">
            <p className="text-xs text-gray-500">Awaiting reconciliation</p>
            <p className="text-2xl font-bold">{formatZAR(stats.unapplied.amount)}</p>
            <p className="text-xs text-gray-400">
              {stats.unapplied.count === 0
                ? "nothing held"
                : `${stats.unapplied.count} receipt${stats.unapplied.count === 1 ? "" : "s"} not applied to a loan`}
            </p>
          </div>
        </div>

        {/* Overdue schedule strip */}
        {overdue.length > 0 && (
          <div className="bg-white rounded-lg border border-amber-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-amber-100 bg-amber-50 flex items-center justify-between">
              <p className="text-sm font-semibold text-amber-800">⚠️ Overdue Installments — {overdue.length} items</p>
              <Link href="/reports/arrears-aging" className="text-xs font-medium text-amber-700 hover:underline">View full aging →</Link>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-amber-50 bg-amber-50/50">
                  <th className="px-4 py-2 text-left font-semibold text-amber-600 uppercase">Client</th>
                  <th className="px-4 py-2 text-left font-semibold text-amber-600 uppercase">Loan</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-600 uppercase">Due Date</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-600 uppercase">Due</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-600 uppercase">Paid</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-600 uppercase">Balance</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-600 uppercase">DPD</th>
                </tr>
              </thead>
              <tbody>
                {overdue.slice(0, 8).map((item: {
                  id: string
                  dueDate: string
                  totalDue: number
                  totalPaid: number
                  status: string
                  loan: { id: string; reference: string; daysInArrears: number; client: { firstName: string; lastName: string } | null; entity: { legalName: string } | null }
                }) => (
                  <tr key={item.id} className="border-b border-amber-50/50 hover:bg-amber-50/30">
                    <td className="px-4 py-2">
                      <Link href={`/collections/${item.loan.id}`} className="font-medium text-gray-700 hover:text-amber-700">
                        {borrowerDisplayName(item.loan)}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-gray-500">{item.loan.reference}</td>
                    <td className="px-4 py-2 text-right text-red-500 font-medium">{formatDate(item.dueDate)}</td>
                    <td className="px-4 py-2 text-right font-medium">{formatZAR(item.totalDue)}</td>
                    <td className="px-4 py-2 text-right text-green-600">{formatZAR(item.totalPaid)}</td>
                    <td className="px-4 py-2 text-right font-bold text-red-600">{formatZAR(item.totalDue - item.totalPaid)}</td>
                    <td className="px-4 py-2 text-right font-bold text-red-600">{item.loan.daysInArrears}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Main tabbed payments panel */}
        <PaymentsClient
          allocated={allocated}
          allocatedCount={allocatedCount}
          unapplied={unapplied}
          resolved={resolved}
          resolvedCount={resolvedCount}
          periodLabel={period.label}
          periodQuery={periodQuery(period)}
          rowCap={ROW_CAP}
        />
      </div>
    </>
  )
}
