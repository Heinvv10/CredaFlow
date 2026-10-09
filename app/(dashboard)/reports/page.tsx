import { prisma } from "@/lib/prisma"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"
import { formatZAR, formatZARCompact, SAST_TIME_ZONE } from "@/lib/utils"
import { TrendingUp, TrendingDown, Download, Users } from "lucide-react"
import Link from "next/link"
import { getDefaultTenantId } from "@/lib/tenant"
import { requireMinRole } from "@/lib/auth-guards"
import { defaultQuarter, quarterLabel, sastMonthBounds, sastQuarterBounds } from "@/lib/compliance/quarters"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { loadChargesOwingByBand } from "@/lib/reports/charges-owing"
import { loadBookAsOf } from "@/lib/reports/book-as-of"

// The collectible book, shared with the NCR return so a PAR figure cannot mean
// one thing here and another on the statutory return. This was ACTIVE+DEFAULTED
// only, which dropped loans parked in the write-off approval queue
// (PENDING_WRITE_OFF) out of both the numerator and the denominator — they are
// still owed and had not reached the write-off line either.
const COLLECTIBLE_LOAN_STATUSES = [...COLLECTIBLE_STATUSES]

async function getReportData() {
  const tenantId = await getDefaultTenantId()
  const now = new Date()
  // End-EXCLUSIVE SAST month bounds. These were `new Date(y, m + 1, 0)` — the
  // last DAY of the month at local midnight — filtered with `lte`, which
  // dropped every receipt after 00:00 on the last day of the month from the
  // collection rate and the month-over-month comparison.
  const { start: monthStart, end: monthEndExclusive } = sastMonthBounds(now)
  const { start: prevMonthStart, end: prevMonthEndExclusive } = sastMonthBounds(now, -1)
  const sixMonthsAgo = sastMonthBounds(now, -5).start

  const [
    prevMonthBook,
    disbursementsThisMonth,
    disbursementsLastMonth,
    arrearsBuckets,
    nplLoans,
    par30Loans,
    par60Loans,
    par90Loans,
    expectedPayments,
    actualPayments,
    recentLoans,
    riskBook,
    parAnyLoans,
    charges,
  ] = await Promise.all([
    // The collectible book as it stood when this month began, rebuilt from
    // receipts — today's balance of older loans is not last month's book. It is
    // compared with riskBook below, the same population today.
    loadBookAsOf(prisma, tenantId, monthStart),
    prisma.loan.aggregate({
      where: { tenantId, startDate: { gte: monthStart } },
      _sum: { principal: true },
      _count: true,
    }),
    prisma.loan.aggregate({
      where: { tenantId, startDate: { gte: prevMonthStart, lt: prevMonthEndExclusive } },
      _sum: { principal: true },
      _count: true,
    }),
    // Arrears buckets over the whole collectible book (the collectible book) so
    // every band uses the same population — otherwise the 90+ DEFAULTED accounts
    // appear in the bucket table but not in PAR90/NPL (audit N-07).
    Promise.all([
      prisma.loan.aggregate({ where: { tenantId, status: { in: COLLECTIBLE_LOAN_STATUSES }, daysInArrears: { gte: 1, lte: 30 } }, _count: true, _sum: { arrearsAmount: true } }),
      prisma.loan.aggregate({ where: { tenantId, status: { in: COLLECTIBLE_LOAN_STATUSES }, daysInArrears: { gte: 31, lte: 60 } }, _count: true, _sum: { arrearsAmount: true } }),
      prisma.loan.aggregate({ where: { tenantId, status: { in: COLLECTIBLE_LOAN_STATUSES }, daysInArrears: { gte: 61, lte: 89 } }, _count: true, _sum: { arrearsAmount: true } }),
      // "90+ DPD" bucket = 90 or more, so the bucket count reconciles with the
      // NPL headline (also >= 90) at the boundary (review L-2).
      prisma.loan.aggregate({ where: { tenantId, status: { in: COLLECTIBLE_LOAN_STATUSES }, daysInArrears: { gte: 90 } }, _count: true, _sum: { arrearsAmount: true } }),
    ]),
    // NPL: 90+ DPD, value-weighted over the collectible book (the collectible book).
    prisma.loan.aggregate({
      where: { tenantId, status: { in: COLLECTIBLE_LOAN_STATUSES }, daysInArrears: { gte: 90 } },
      _sum: { outstandingPrincipal: true },
      _count: true,
    }),
    // PAR30/60/90 over the collectible book (the collectible book).
    prisma.loan.aggregate({
      where: { tenantId, status: { in: COLLECTIBLE_LOAN_STATUSES }, daysInArrears: { gte: 30 } },
      _sum: { outstandingPrincipal: true },
    }),
    prisma.loan.aggregate({
      where: { tenantId, status: { in: COLLECTIBLE_LOAN_STATUSES }, daysInArrears: { gte: 60 } },
      _sum: { outstandingPrincipal: true },
    }),
    prisma.loan.aggregate({
      where: { tenantId, status: { in: COLLECTIBLE_LOAN_STATUSES }, daysInArrears: { gte: 90 } },
      _sum: { outstandingPrincipal: true },
    }),
    // Collection rate
    prisma.repaymentSchedule.aggregate({
      where: { tenantId, dueDate: { gte: monthStart, lt: monthEndExclusive } },
      _sum: { totalDue: true },
    }),
    prisma.payment.aggregate({
      where: {
        tenantId,
        receivedAt: { gte: monthStart, lt: monthEndExclusive },
        reversed: false,
        allocationStatus: "ALLOCATED",
        ...CASH_RECEIPTS,
      },
      _sum: { amount: true },
    }),
    // Disbursement trend (last 6 months)
    prisma.loan.findMany({
      where: { tenantId, startDate: { gte: sixMonthsAgo } },
      select: { startDate: true, principal: true },
    }),
    // Risk book = outstanding principal of the whole collectible book
    // (the collectible book). This is the denominator for every PAR/NPL/arrears
    // ratio so numerator and denominator share one population — a PAR numerator
    // that included DEFAULTED loans over an ACTIVE-only book could read >100%
    // (audit N-06/N-07).
    prisma.loan.aggregate({
      where: { tenantId, status: { in: COLLECTIBLE_LOAN_STATUSES } },
      _sum: { outstandingPrincipal: true },
      _count: true,
    }),
    // Value-weighted PAR1+ (any arrears) for the headline "arrears rate".
    prisma.loan.aggregate({
      where: { tenantId, status: { in: COLLECTIBLE_LOAN_STATUSES }, daysInArrears: { gte: 1 } },
      _sum: { outstandingPrincipal: true },
    }),
    // Default charges owing, beside (never inside) the instalment arrears above.
    loadChargesOwingByBand(prisma, tenantId, COLLECTIBLE_LOAN_STATUSES),
  ])

  // Collections stage funnel — separate query
  const stageFunnel = await prisma.loan.groupBy({
    by: ["collectionsStage"],
    where: { tenantId, status: { in: COLLECTIBLE_LOAN_STATUSES } },
    _count: true,
    _sum: { arrearsAmount: true, outstandingPrincipal: true },
  })

  // Write-offs this quarter
  // SAST quarter bounds, and keyed on writeOffAt alone — the same fix as
  // lib/compliance/ncr-return.ts. A status predicate here would let any later
  // transition off WRITTEN_OFF retroactively erase the loan from a closed
  // quarter, and would make this figure disagree with the return's.
  const { start: quarterStart } = sastQuarterBounds(now)
  const writeOffs = await prisma.loan.aggregate({
    where: { tenantId, writeOffAt: { gte: quarterStart } },
    _count: true,
    _sum: { outstandingPrincipal: true },
  })

  const totalArrears = arrearsBuckets.reduce((s, b) => s + Number(b._sum.arrearsAmount || 0), 0)
  const totalLoansInArrears = arrearsBuckets.reduce((s, b) => s + (b._count || 0), 0)
  // Ratio denominator = the whole collectible book (the collectible book), and
  // the headline book, so it compares like-for-like with the rebuilt book at the
  // start of the month. Ratios use it so their numerators (which include
  // DEFAULTED accounts) can never exceed 100% (audit N-06).
  const riskBookAmount = Number(riskBook._sum.outstandingPrincipal || 0)
  // Value-weighted arrears rate = outstanding principal of any-arrears accounts
  // ÷ collectible book. Bounded by construction, and consistent with PAR30/60/90.
  const arrearsRate = riskBookAmount > 0 ? (Number(parAnyLoans._sum.outstandingPrincipal || 0) / riskBookAmount) * 100 : 0
  // Collections rate = share of the collectible book (the collectible book) NOT in
  // arrears. Numerator and denominator must share the same population — using an
  // ACTIVE-only denominator while totalLoansInArrears counts DEFAULTED loans too
  // can render a negative rate (review I-1).
  const collectibleLoanCount = riskBook._count
  const basicCollectionsRate = collectibleLoanCount > 0 ? ((collectibleLoanCount - totalLoansInArrears) / collectibleLoanCount) * 100 : 100
  const avgDisbursement = disbursementsThisMonth._count > 0
    ? Number(disbursementsThisMonth._sum.principal || 0) / disbursementsThisMonth._count
    : 0

  // NPL ratio
  const nplAmount = Number(nplLoans._sum.outstandingPrincipal || 0)
  const nplRatio = riskBookAmount > 0 ? (nplAmount / riskBookAmount) * 100 : 0

  // PAR ratios
  const par30Pct = riskBookAmount > 0 ? (Number(par30Loans._sum.outstandingPrincipal || 0) / riskBookAmount) * 100 : 0
  const par60Pct = riskBookAmount > 0 ? (Number(par60Loans._sum.outstandingPrincipal || 0) / riskBookAmount) * 100 : 0
  const par90Pct = riskBookAmount > 0 ? (Number(par90Loans._sum.outstandingPrincipal || 0) / riskBookAmount) * 100 : 0

  // Collection rate
  const expectedTotal = Number(expectedPayments._sum.totalDue || 0)
  const actualTotal = Number(actualPayments._sum.amount || 0)
  const collectionRate = expectedTotal > 0 ? (actualTotal / expectedTotal) * 100 : 100

  // Disbursement trend — aggregate by month
  const monthlyDisbursements: { month: string; amount: number }[] = []
  for (let i = 5; i >= 0; i--) {
    const { start: mStart, end: mEndExclusive } = sastMonthBounds(now, -i)
    const label = mStart.toLocaleString("en-ZA", { month: "short", year: "2-digit", timeZone: SAST_TIME_ZONE })
    const total = recentLoans
      .filter((l) => {
        const sd = new Date(l.startDate)
        return sd >= mStart && sd < mEndExclusive
      })
      .reduce((s, l) => s + Number(l.principal), 0)
    monthlyDisbursements.push({ month: label, amount: total })
  }

  return {
    // Collectible book (the collectible book) — the denominator for every at-risk
    // ratio, including the arrears-bucket "% of book" (review I-2).
    riskBook: riskBookAmount,
    prevBook: prevMonthBook,
    disbursements: Number(disbursementsThisMonth._sum.principal || 0),
    prevDisbursements: Number(disbursementsLastMonth._sum.principal || 0),
    disbursementCount: disbursementsThisMonth._count,
    avgDisbursement,
    arrearsRate,
    basicCollectionsRate,
    arrearsBuckets: [
      { label: "1-30 DPD", accounts: arrearsBuckets[0]._count || 0, balance: Number(arrearsBuckets[0]._sum.arrearsAmount || 0), color: "#f59e0b" },
      { label: "31-60 DPD", accounts: arrearsBuckets[1]._count || 0, balance: Number(arrearsBuckets[1]._sum.arrearsAmount || 0), color: "#e65100" },
      { label: "61-89 DPD", accounts: arrearsBuckets[2]._count || 0, balance: Number(arrearsBuckets[2]._sum.arrearsAmount || 0), color: "#b71c1c" },
      { label: "90+ DPD", accounts: arrearsBuckets[3]._count || 0, balance: Number(arrearsBuckets[3]._sum.arrearsAmount || 0), color: "#7b1010" },
    ],
    totalArrears,
    charges,
    nplRatio,
    nplAmount,
    nplCount: nplLoans._count,
    par30Pct,
    par60Pct,
    par90Pct,
    collectionRate,
    expectedTotal,
    actualTotal,
    monthlyDisbursements,
    stageFunnel: stageFunnel.map(s => ({
      stage: s.collectionsStage ?? "NONE",
      count: s._count,
      arrears: Number(s._sum.arrearsAmount || 0),
      outstanding: Number(s._sum.outstandingPrincipal || 0),
    })),
    writeOffsQtr: writeOffs._count,
    writeOffAmountQtr: Number(writeOffs._sum.outstandingPrincipal || 0),
  }
}

function ReportKpiCard({ title, value, sub, change, changeUp, borderColor }: {
  title: string; value: string; sub?: string; change?: string; changeUp?: boolean; borderColor: string
}) {
  return (
    <div
      className="bg-white rounded-lg shadow-sm p-4 relative overflow-hidden"
      style={{ borderLeft: `4px solid ${borderColor}` }}
    >
      <div
        className="absolute top-0 right-0 w-[60px] h-[60px] opacity-[0.04] rounded-bl-[60px]"
        style={{ backgroundColor: borderColor }}
      />
      <p className="text-[10px] font-semibold uppercase tracking-[0.8px] text-[#8f95a3] mb-1.5">{title}</p>
      <p className="text-[24px] font-extrabold text-[#1b1d24] leading-none">{value}</p>
      {sub && <p className="text-[10px] text-[#a9aeb9] mt-1.5">{sub}</p>}
      {change && (
        <div className="flex items-center gap-1 mt-2">
          {changeUp !== undefined && (
            changeUp
              ? <TrendingUp className="h-3 w-3 text-[#1e6b3f]" />
              : <TrendingDown className="h-3 w-3 text-[#b71c1c]" />
          )}
          <span className={`text-[10px] font-medium ${changeUp ? "text-[#1e6b3f]" : "text-[#b71c1c]"}`}>{change}</span>
        </div>
      )}
    </div>
  )
}

function nplColor(ratio: number): string {
  if (ratio >= 5) return "text-red-600"
  if (ratio >= 2) return "text-orange-600"
  return "text-green-600"
}

function collectionColor(rate: number): string {
  if (rate >= 95) return "text-green-600"
  if (rate >= 85) return "text-orange-600"
  return "text-red-600"
}

// Periods are what each link opens on: the NCR return and export default to
// the last completed quarter when no ?quarter= is given. Computed per request —
// a module-level constant would keep the quarter the server started in.
const ncrReports = (ncrQuarter: string) => [
  { name: "Credit Agreements Register", period: "All time", href: "/api/reports/export?type=credit-agreements" },
  { name: "Quarterly NCR Return", period: ncrQuarter, href: "/compliance/ncr-return" },
  { name: "NCR Quarterly Export (Excel)", period: ncrQuarter, href: "/api/reports/export?type=ncr-quarterly" },
  { name: "Arrears Aging Report", period: "As at today", href: "/reports/arrears-aging" },
  { name: "Section 129 Notices Log", period: "All time", href: "/api/reports/export?type=section129-log" },
  { name: "Reckless Lending Audit", period: "All time", href: "/api/reports/export?type=reckless-lending" },
  { name: "Affordability Assessment Register", period: "All time", href: "/api/reports/export?type=affordability" },
  { name: "Payments Register", period: "All time", href: "/api/reports/export?type=payments" },
  { name: "Month-End Reconciliation", period: "Current month", href: "/api/reports/export?type=reconciliation" },
  { name: "FSCA Quarterly Return (Excel)", period: "Previous quarter", href: "/api/reports/export?type=fsca-quarterly" },
  { name: "FSCA Annual Return (Excel)", period: "All time", href: "/api/reports/export?type=fsca-annual" },
]

export default async function ReportsPage() {
  // Portfolio/board reporting exposes strategic figures (book value, PAR,
  // disbursements). This overview queries Prisma directly; its sibling
  // reports/advisor API gates at LOAN_ADMIN, so match that here — collections
  // and credit roles shouldn't see executive numbers they can't action (F-29).
  await requireMinRole("LOAN_ADMIN")
  const data = await getReportData()

  const bookChangeAbs = data.riskBook - data.prevBook
  const bookChangePct = data.prevBook > 0 ? (bookChangeAbs / data.prevBook) * 100 : 0
  const currentMonth = new Date().toLocaleString("en-ZA", { month: "long", timeZone: SAST_TIME_ZONE })
  const maxDisbursement = Math.max(...data.monthlyDisbursements.map((d) => d.amount), 1)

  return (
    <div>
      {/* Header Bar */}
      <div className="flex flex-col gap-3 border-b border-[#e2e5ea] bg-white px-6 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[17px] font-bold text-[#1b1d24]">Reports</h1>
          <p className="text-[11px] text-[#8f95a3]">Portfolio analytics and NCR compliance</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/reports/advisor"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1565c0] text-white rounded-lg text-xs font-semibold hover:bg-[#1248a0] transition-colors">
            <Users className="h-3.5 w-3.5" />Advisor Report
          </Link>
          <Link href="/reports/board-pack"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#4F46E5] text-white rounded-lg text-xs font-semibold hover:bg-[#4338CA] transition-colors">
            Board Pack
          </Link>
          <Link href="/reports/default-charges"
            className="flex items-center gap-1.5 px-3 py-1.5 border border-[#4F46E5] text-[#4F46E5] rounded-lg text-xs font-semibold hover:bg-[#eef2ff] transition-colors">
            Default Charges
          </Link>
          <div className="flex flex-wrap items-center gap-1.5">
            <a href="/api/reports/export?type=loans" download
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1e6b3f] text-white rounded-lg text-xs font-semibold hover:bg-[#155030] transition-colors">
              <Download className="h-3.5 w-3.5" />Loans Excel
            </a>
            <a href="/api/reports/export?type=par" download
              className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs font-semibold hover:bg-gray-50 transition-colors">
              <Download className="h-3.5 w-3.5" />PAR Excel
            </a>
          </div>
        </div>
      </div>

      {/* KPI Cards Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 p-6">
        <ReportKpiCard
          title={`COLLECTIBLE BOOK (${currentMonth.toUpperCase()})`}
          value={formatZARCompact(data.riskBook)}
          sub="Active, defaulted, pending write-off and restructured loans"
          change={bookChangePct !== 0 ? `${Math.abs(bookChangePct).toFixed(0)}% vs start of month` : undefined}
          changeUp={bookChangePct >= 0}
          borderColor="#1e6b3f"
        />
        <ReportKpiCard
          title="DISBURSEMENTS"
          value={formatZARCompact(data.disbursements)}
          sub={`${data.disbursementCount} loan${data.disbursementCount !== 1 ? "s" : ""}${data.avgDisbursement > 0 ? `, avg ${formatZAR(data.avgDisbursement)}` : ""}`}
          borderColor="#4f46e5"
        />
        <ReportKpiCard
          title="PAR — AT-RISK BOOK %"
          value={`${data.arrearsRate.toFixed(1)}%`}
          sub="Outstanding principal of accounts in arrears ÷ book"
          borderColor="#b71c1c"
        />
        <ReportKpiCard
          title="ACCOUNTS UP TO DATE"
          value={`${data.basicCollectionsRate.toFixed(1)}%`}
          sub="Collectible accounts with no arrears"
          borderColor="#1565c0"
        />
      </div>

      {/* NPL + PAR + Collection Rate */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 px-6 pb-6">
        {/* NPL Ratio */}
        <div className="bg-white rounded-lg border border-[#e5e7eb] p-5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.8px] text-[#8f95a3] mb-3">NPL RATIO</h3>
          <p className={`text-[28px] font-extrabold leading-none ${nplColor(data.nplRatio)}`}>
            {data.nplRatio.toFixed(1)}%
          </p>
          <p className="text-[11px] text-[#a9aeb9] mt-2">
            {formatZAR(data.nplAmount)} across {data.nplCount} loan{data.nplCount !== 1 ? "s" : ""} (90+ DPD)
          </p>
          <div className="mt-3 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(data.nplRatio * 10, 100)}%`,
                backgroundColor: data.nplRatio >= 5 ? "#b71c1c" : data.nplRatio >= 2 ? "#e65100" : "#1e6b3f",
              }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-gray-400 mt-1">
            <span>0%</span>
            <span>Target &lt;5%</span>
            <span>10%</span>
          </div>
        </div>

        {/* PAR */}
        <div className="bg-white rounded-lg border border-[#e5e7eb] p-5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.8px] text-[#8f95a3] mb-3">PORTFOLIO AT RISK</h3>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "PAR30", value: data.par30Pct },
              { label: "PAR60", value: data.par60Pct },
              { label: "PAR90", value: data.par90Pct },
            ].map((par) => (
              <div key={par.label} className="text-center">
                <p className="text-[10px] font-semibold text-[#8f95a3] mb-1">{par.label}</p>
                <p className={`text-[20px] font-extrabold ${par.value > 10 ? "text-red-600" : par.value > 5 ? "text-orange-600" : "text-green-600"}`}>
                  {par.value.toFixed(1)}%
                </p>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-[#a9aeb9] mt-3 text-center">
            % of outstanding book with DPD at or above threshold
          </p>
        </div>

        {/* Collection Rate */}
        <div className="bg-white rounded-lg border border-[#e5e7eb] p-5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.8px] text-[#8f95a3] mb-3">COLLECTION RATE ({currentMonth.toUpperCase()})</h3>
          <p className={`text-[28px] font-extrabold leading-none ${collectionColor(data.collectionRate)}`}>
            {data.collectionRate.toFixed(1)}%
          </p>
          <p className="text-[11px] text-[#a9aeb9] mt-2">
            {formatZAR(data.actualTotal)} received of {formatZAR(data.expectedTotal)} expected
          </p>
          <div className="mt-3 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(data.collectionRate, 100)}%`,
                backgroundColor: data.collectionRate >= 95 ? "#1e6b3f" : data.collectionRate >= 85 ? "#e65100" : "#b71c1c",
              }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-gray-400 mt-1">
            <span>0%</span>
            <span>Target &gt;95%</span>
            <span>100%</span>
          </div>
        </div>
      </div>

      {/* Disbursement Trend */}
      <div className="px-6 pb-6">
        <div className="bg-white rounded-lg border border-[#e5e7eb] p-5">
          <h3 className="font-bold text-[#1b1d24] mb-4">Disbursement Trend (Last 6 Months)</h3>
          <div className="space-y-2">
            {data.monthlyDisbursements.map((m) => (
              <div key={m.month} className="flex items-center gap-3">
                <span className="text-xs text-gray-500 w-16 text-right font-medium">{m.month}</span>
                <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all flex items-center pl-2"
                    style={{
                      width: `${Math.max((m.amount / maxDisbursement) * 100, 2)}%`,
                      backgroundColor: "#4F46E5",
                    }}
                  >
                    {m.amount > 0 && (
                      <span className="text-[9px] font-bold text-white whitespace-nowrap">
                        {formatZARCompact(m.amount)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Two-Column Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 px-6 pb-6">
        {/* Arrears Buckets */}
        <div className="bg-white rounded-lg border border-[#e5e7eb] overflow-hidden">
          <div className="px-5 py-4 border-b border-[#e5e7eb]">
            <h3 className="font-bold text-[#1b1d24]">Arrears Buckets</h3>
          </div>
          <table className="lms-table w-full text-sm">
            <thead>
              <tr>
                <th>Bucket</th>
                <th>Accounts</th>
                <th>Balance</th>
                {data.charges.chargesLive && <th>Default charges</th>}
                <th>% of Book</th>
              </tr>
            </thead>
            <tbody>
              {data.arrearsBuckets.map((bucket) => {
                // Divide by the collectible book (the collectible book), not the
                // ACTIVE-only book — bucket balances include DEFAULTED arrears so
                // an ACTIVE-only denominator can exceed 100% (review I-2).
                const pct = data.riskBook > 0 ? (bucket.balance / data.riskBook) * 100 : 0
                return (
                  <tr key={bucket.label}>
                    <td className="font-medium text-[#262a33]">{bucket.label}</td>
                    <td className="text-[#4b5060]">{bucket.accounts}</td>
                    <td className="font-medium text-[#262a33]">{formatZAR(bucket.balance)}</td>
                    {data.charges.chargesLive && (
                      <td className="text-[#4b5060]">{formatZAR(data.charges.byBand[bucket.label as keyof typeof data.charges.byBand])}</td>
                    )}
                    <td>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 bg-[#eceef2] rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.min(pct * 10, 100)}%`, backgroundColor: bucket.color }}
                          />
                        </div>
                        <span className="text-[11px] font-medium text-[#4b5060] w-10 text-right">{pct.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {data.charges.chargesLive && (
            <p className="px-5 py-3 text-[11px] text-[#7a8191] border-t border-[#e5e7eb]">
              Balance is unpaid instalments only. Default charges owing: {formatZAR(data.charges.total)}
              {data.charges.notInArrears.count > 0 && <>, incl. {formatZAR(data.charges.notInArrears.amount)} on {data.charges.notInArrears.count} {data.charges.notInArrears.count === 1 ? "loan" : "loans"} with no instalment arrears</>}
              {" "}(as at the last nightly update).
            </p>
          )}
        </div>

        {/* Collections Stage Funnel */}
        <div className="bg-white rounded-lg border border-[#e5e7eb] overflow-hidden lg:col-span-2">
          <div className="px-5 py-4 border-b border-[#e5e7eb] flex items-center justify-between">
            <div>
              <h3 className="font-bold text-[#1b1d24]">Collections Stage Funnel</h3>
              <p className="text-xs text-[#7a8191] mt-0.5">Collectible accounts by escalation stage</p>
            </div>
            {data.writeOffsQtr > 0 && (
              <div className="text-right">
                <p className="text-[10px] text-[#7a8191] font-semibold uppercase">Written Off (Qtr)</p>
                <p className="text-sm font-bold text-red-600">{data.writeOffsQtr} accounts · <span className="whitespace-nowrap">{formatZAR(data.writeOffAmountQtr)}</span></p>
              </div>
            )}
          </div>
          <div className="px-5 py-4">
            {([
              { key: "NONE",               label: "No Action",           color: "#9CA3AF" },
              { key: "SOFT_REMINDER",      label: "Soft Reminder",       color: "#3B82F6" },
              { key: "FORMAL_REMINDER",   label: "Formal Reminder",     color: "#F59E0B" },
              { key: "SECTION_129_SENT",  label: "Section 129 Issued",  color: "#EF4444" },
              { key: "PAYMENT_ARRANGEMENT", label: "Payment Arrangement", color: "#10B981" },
              { key: "ATTORNEY_REFERRED", label: "Attorney Referred",   color: "#8B5CF6" },
              { key: "WRITTEN_OFF",       label: "Written Off",         color: "#1F2937" },
            ] as const).map(({ key, label, color }) => {
              const s = data.stageFunnel.find(f => f.stage === key)
              const count = s?.count ?? 0
              const arrears = s?.arrears ?? 0
              const maxCount = Math.max(...data.stageFunnel.map(f => f.count), 1)
              return (
                <div key={key} className="flex items-center gap-3 mb-3">
                  <div className="w-36 text-[11px] font-medium text-[#4b5060] flex-shrink-0">{label}</div>
                  <div className="flex-1 bg-[#eceef2] rounded-full h-2 overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${(count / maxCount) * 100}%`, backgroundColor: color }} />
                  </div>
                  <div className="w-8 text-right text-[12px] font-bold" style={{ color }}>{count}</div>
                  {arrears > 0 && <div className="whitespace-nowrap w-28 text-right text-[11px] text-[#7a8191]">{formatZAR(arrears)}</div>}
                </div>
              )
            })}
          </div>
        </div>

        {/* NCR Compliance Reports */}
        <div className="bg-white rounded-lg border border-[#e5e7eb] overflow-hidden">
          <div className="px-5 py-4 border-b border-[#e5e7eb]">
            <h3 className="font-bold text-[#1b1d24]">NCR Compliance Reports</h3>
          </div>
          <table className="lms-table w-full text-sm">
            <thead>
              <tr>
                <th>Report</th>
                <th>Period</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ncrReports(quarterLabel(defaultQuarter())).map((report) => (
                <tr key={report.name}>
                  <td className="font-medium text-[#262a33]">{report.name}</td>
                  <td className="text-[#4b5060]">{report.period}</td>
                  <td>
                    <Link href={report.href} className="btn-outline-gold inline-block text-center">
                      {report.href.startsWith("/api") ? "Export" : "View"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
