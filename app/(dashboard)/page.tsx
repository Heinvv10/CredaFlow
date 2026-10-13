import { prisma } from "@/lib/prisma"
import { arrearsWithCharges } from "@/lib/loan/charge-labels"
import { chargesLiveForTenant } from "@/lib/loan/charges-replay"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"
import { collectibleLoanWhere, COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { formatZAR, SAST_TIME_ZONE } from "@/lib/utils"
import { auth } from "@/lib/auth"
import { getDefaultTenantId } from "@/lib/tenant"
import { sastMonthBounds, sastQuarterBounds } from "@/lib/compliance/quarters"
import { getPortfolioPar } from "@/lib/reports/par"
import { getAvatarColor, getInitials, getInitialsFromName } from "@/lib/avatar"
import { borrowerDisplayName } from "@/lib/borrower"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { SectionHeader } from "@/components/app-shell/SectionHeader"
import { StatusPill } from "@/components/app-shell/StatusPill"
import {
  Plus, TrendingUp, TrendingDown, AlertTriangle, CheckCircle,
  DollarSign, Users, BarChart3, ArrowRight
} from "lucide-react"
import { sastHour } from "@/lib/date/sast"

type StatusTone = "neutral" | "success" | "warning" | "danger" | "info" | "bronze"

async function getMyTasks(userId: string, tenantId: string) {
  return prisma.agentTask.findMany({
    where: { tenantId, assigneeId: userId, status: { in: ["PENDING", "IN_PROGRESS"] } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: 5,
  })
}

async function getDashboardData(tenantId: string) {
  const now = new Date()
  // SAST boundary: the container has no TZ, so date parts resolve in UTC and
  // land two hours inside the previous South African day.
  const monthStart = sastMonthBounds(now).start
  const prevMonthStart = sastMonthBounds(now, -1).start
  // A rolling 7×24h window, not a calendar week — deliberately unchanged.
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const quarterStart = sastQuarterBounds(now).start

  const [
    collectibleLoans,
    portfolioAgg,
    arrearsAgg,
    par,
    pendingApps,
    approvedReady,
    disbursedMonth, disbursedPrevMonth,
    collectionsToday,
    paymentsWeek,
    topArrears,
    writeOffsQtr,
    recentPayments,
  ] = await Promise.all([
    // Counts the same population as `bookValue` below, so the card's count and
    // its value describe one set. It was an ACTIVE-only count sitting beside a
    // collectible-book value.
    prisma.loan.count({ where: collectibleLoanWhere(tenantId) }),
    // The collectible book, so this figure shares its population with the PAR
    // percentages rendered beside it. It was ACTIVE-only while those ratios
    // divided by a wider book.
    prisma.loan.aggregate({ where: collectibleLoanWhere(tenantId), _sum: { outstandingPrincipal: true } }),
    prisma.loan.aggregate({ where: { tenantId, status: { in: [...COLLECTIBLE_STATUSES] }, daysInArrears: { gt: 0 }, arrearsAmount: { gt: 0 } }, _sum: { arrearsAmount: true, chargesOutstanding: true }, _count: true }),
    getPortfolioPar(tenantId),
    prisma.loanApplication.findMany({
      where: { tenantId, status: { in: ["SUBMITTED","UNDER_REVIEW"] } },
      take: 6,
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { firstName: true, lastName: true } },
        entity: { select: { legalName: true } },
        product: { select: { name: true } },
      },
    }),
    prisma.loanApplication.findMany({
      where: {
        tenantId,
        status: "APPROVED",
        agreementSignedAt: { not: null },
        agreementCountersignedAt: { not: null },
      },
      take: 3,
      orderBy: { approvedAt: "desc" },
      include: { client: { select: { firstName: true, lastName: true } }, entity: { select: { legalName: true } } },
    }),
    prisma.loan.aggregate({ where: { tenantId, startDate: { gte: monthStart } }, _sum: { principal: true }, _count: true }),
    prisma.loan.aggregate({ where: { tenantId, startDate: { gte: prevMonthStart, lt: monthStart } }, _sum: { principal: true }, _count: true }),
    prisma.loan.count({ where: { tenantId, status: { in: [...COLLECTIBLE_STATUSES] }, daysInArrears: { gt: 0 }, arrearsAmount: { gt: 0 } } }),
    prisma.payment.aggregate({
      where: {
        tenantId,
        receivedAt: { gte: weekStart },
        reversed: false,
        allocationStatus: "ALLOCATED",
        ...CASH_RECEIPTS,
      },
      _sum: { amount: true }, _count: true,
    }),
    prisma.loan.findMany({
      where: { tenantId, status: { in: [...COLLECTIBLE_STATUSES] }, daysInArrears: { gt: 0 }, arrearsAmount: { gt: 0 } },
      orderBy: { daysInArrears: "desc" },
      take: 6,
      include: { client: { select: { firstName: true, lastName: true } }, entity: { select: { legalName: true } } },
    }),
    prisma.loan.count({ where: { tenantId, status: "WRITTEN_OFF", writeOffAt: { gte: quarterStart } } }),
    prisma.payment.findMany({
      // Money in only: a waived balance is not a payment.
      where: { tenantId, reversed: false, allocationStatus: "ALLOCATED", ...CASH_RECEIPTS },
      orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
      take: 5,
      include: { loan: { include: { client: { select: { firstName: true, lastName: true } }, entity: { select: { legalName: true } } } } },
    }),
  ])

  const bookValue = portfolioAgg._sum.outstandingPrincipal ?? 0
  // Arrears shown to people include default charges owed (synced summary column).
  const chargesLive = await chargesLiveForTenant(prisma, tenantId)
  const totalArrears = (arrearsAgg._sum.arrearsAmount ?? 0) + (chargesLive ? arrearsAgg._sum.chargesOutstanding ?? 0 : 0)
  const arrearsCount = arrearsAgg._count
  const thisMonth = disbursedMonth._sum.principal ?? 0
  const prevMonth = disbursedPrevMonth._sum.principal ?? 0
  const monthTrend = prevMonth > 0 ? ((thisMonth - prevMonth) / prevMonth) * 100 : 0

  return {
    chargesLive,
    collectibleLoans, bookValue, totalArrears, arrearsCount,
    par,
    pendingApps, approvedReady,
    thisMonth, monthTrend, disbursedMonthCount: disbursedMonth._count,
    collectionsToday, paymentsWeek: paymentsWeek._sum.amount ?? 0, paymentsWeekCount: paymentsWeek._count,
    topArrears, writeOffsQtr, recentPayments,
  }
}

function fmt(cents: number) {
  const v = cents / 100
  if (v >= 1_000_000) return `R ${(v / 1_000_000).toFixed(2)}m`
  if (v >= 1_000) return `R ${(v / 1_000).toFixed(0)}k`
  return formatZAR(cents)
}

function dpdTone(dpd: number): StatusTone {
  if (dpd >= 90) return "danger"
  if (dpd >= 30) return "warning"
  return "neutral"
}

function taskTone(priority: string): string {
  if (priority === "HIGH") return "bg-[var(--cf-danger)]"
  if (priority === "MEDIUM") return "bg-[var(--cf-warning)]"
  return "bg-[var(--cf-text-muted)]"
}

export default async function DashboardPage() {
  const session = await auth()
  const userId = session?.user?.id
  const tenantId = await getDefaultTenantId()
  const [d, myTasks] = await Promise.all([
    getDashboardData(tenantId),
    userId ? getMyTasks(userId, tenantId) : Promise.resolve([]),
  ])
  const now = new Date()
  // SAST hour: the container is UTC, so a staff member logging in at 08:00
  // SAST was greeted "Good morning" from a clock reading 06:00 — harmless
  // there, wrong at the edges (17:30 SAST still said "Good afternoon").
  const hour = sastHour(now)
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"
  const userName = session?.user?.name?.split(" ")[0] || "there"
  const dateStr = now.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: SAST_TIME_ZONE })
  const monthName = now.toLocaleDateString("en-ZA", { month: "long", timeZone: SAST_TIME_ZONE })

  return (
    <div className="space-y-6 p-4 lg:p-8">
      <SectionHeader
        eyebrow="Executive dashboard"
        title={`${greeting}, ${userName}`}
        description={dateStr}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/applications/new"><Plus className="h-4 w-4" />New application</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/payments"><DollarSign className="h-4 w-4" />Capture payment</Link>
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Book value" value={fmt(d.bookValue)} detail={`${d.collectibleLoans} loans owed`} />
        <MetricCard
          label={`Disbursed (${monthName})`}
          value={fmt(d.thisMonth)}
          detail={
            <span className="inline-flex items-center gap-1">
              {d.monthTrend >= 0 ? <TrendingUp className="h-3 w-3 text-[var(--cf-success)]" /> : <TrendingDown className="h-3 w-3 text-[var(--cf-danger)]" />}
              {d.monthTrend >= 0 ? "+" : ""}{d.monthTrend.toFixed(1)}% vs last month - {d.disbursedMonthCount} loans
            </span>
          }
          tone={d.monthTrend >= 0 ? "success" : "danger"}
        />
        <MetricCard
          label="Total arrears"
          value={fmt(d.totalArrears)}
          detail={`${d.arrearsCount} accounts`}
          tone={d.arrearsCount > 0 ? "danger" : "neutral"}
          className={d.arrearsCount > 0 ? "bg-[rgba(208,92,75,0.08)]" : undefined}
        />
        <MetricCard label="Collected (7 days)" value={fmt(d.paymentsWeek)} detail={`${d.paymentsWeekCount} payments`} tone="success" />
      </div>

      <DataPanel
        title="Portfolio at risk"
        description={`${d.collectionsToday} account${d.collectionsToday === 1 ? "" : "s"} currently in the collections queue.`}
        variant="raised"
        density="loose"
        actions={<Button asChild variant="outline" size="sm"><Link href="/reports/arrears-aging">Full aging report</Link></Button>}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { label: "PAR 30+", b: d.par.par30, tone: "warning" as StatusTone },
            { label: "PAR 60+", b: d.par.par60, tone: "warning" as StatusTone },
            { label: "PAR 90+", b: d.par.par90, tone: "danger" as StatusTone },
          ].map((bucket) => (
            <div key={bucket.label} className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">{bucket.label}</p>
                <StatusPill tone={bucket.tone}>{bucket.b.pct.toFixed(1)}%</StatusPill>
              </div>
              <p className="mt-3 text-3xl font-semibold tabular-nums text-[var(--cf-text)]">{bucket.b.count}</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--cf-surface-strong)]">
                <div className="h-full rounded-full bg-[var(--cf-brand)]" style={{ width: `${Math.min(100, bucket.b.pct)}%` }} />
              </div>
            </div>
          ))}
        </div>
        {d.writeOffsQtr > 0 && (
          <InfoStrip variant="danger" className="mt-4">
            {d.writeOffsQtr} write-off{d.writeOffsQtr !== 1 ? "s" : ""} recorded this quarter.
          </InfoStrip>
        )}
      </DataPanel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-7">
          <DataPanel
            title="Pending applications"
            description="Advisor review and submitted applications requiring attention."
            actions={<Button asChild variant="outline" size="sm"><Link href="/applications">View all</Link></Button>}
          >
            {d.pendingApps.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-[var(--cf-text-muted)]">
                <CheckCircle className="h-8 w-8 text-[var(--cf-success)]" />
                <p>All caught up - no pending applications</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--cf-border-subtle)]">
                      <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">Client</th>
                      <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">Product</th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">Amount</th>
                      <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.pendingApps.map(app => {
                      const name = borrowerDisplayName(app)
                      const initials = app.client
                        ? getInitials(app.client.firstName, app.client.lastName)
                        : getInitialsFromName(name, "?")
                      const avatarColor = getAvatarColor(name)
                      return (
                        <tr key={app.id} className="border-b border-[var(--cf-border-subtle)] last:border-0">
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-2">
                              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: avatarColor }}>
                                {initials}
                              </div>
                              <Link href={`/applications/${app.id}`} className="font-medium text-[var(--cf-text)] hover:text-[var(--cf-brand)]">
                                {name}
                              </Link>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-[var(--cf-text-muted)]">{app.product.name}</td>
                          <td className="px-3 py-3 text-right font-semibold tabular-nums text-[var(--cf-text)]">{fmt(app.appliedAmount)}</td>
                          <td className="px-3 py-3">
                            <StatusPill tone={app.status === "UNDER_REVIEW" ? "warning" : "info"}>
                              {app.status === "UNDER_REVIEW" ? "In review" : "Submitted"}
                            </StatusPill>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </DataPanel>

          {d.approvedReady.length > 0 && (
            <DataPanel
              title="Ready to disburse"
              description="Approved and signed agreements awaiting payout."
              variant="accent"
              actions={<Button asChild variant="outline" size="sm"><Link href="/disbursements">Disbursements</Link></Button>}
            >
              <div className="divide-y divide-[var(--cf-border-subtle)]">
                {d.approvedReady.map(app => (
                  <div key={app.id} className="flex items-center justify-between gap-4 py-3">
                    <span className="text-sm font-medium text-[var(--cf-text)]">{borrowerDisplayName(app)}</span>
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/applications/${app.id}`}>Disburse <ArrowRight className="h-3 w-3" /></Link>
                    </Button>
                  </div>
                ))}
              </div>
            </DataPanel>
          )}

          <DataPanel
            title="Recent payments"
            description="Latest receipts posted to the loan book."
            actions={<Button asChild variant="outline" size="sm"><Link href="/payments">View all</Link></Button>}
          >
            {d.recentPayments.length === 0 ? (
              <div className="py-6 text-center text-sm text-[var(--cf-text-muted)]">No payments recorded yet</div>
            ) : (
              <div className="divide-y divide-[var(--cf-border-subtle)]">
                {d.recentPayments.map(p => (
                  <div key={p.id} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[var(--cf-text)]">{borrowerDisplayName(p.loan)}</p>
                      <p className="text-xs text-[var(--cf-text-muted)]">{p.loan.reference}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold tabular-nums text-[var(--cf-success)]">+{fmt(p.amount)}</p>
                      <p className="text-xs text-[var(--cf-text-muted)]">{new Date(p.createdAt).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", timeZone: SAST_TIME_ZONE })}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DataPanel>
        </div>

        <div className="space-y-4 lg:col-span-5">
          <DataPanel
            title="Arrears - top accounts"
            description="Prioritised by days past due."
            actions={<Button asChild variant="outline" size="sm"><Link href="/collections">Full queue</Link></Button>}
          >
            {d.topArrears.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-[var(--cf-text-muted)]">
                <CheckCircle className="h-7 w-7 text-[var(--cf-success)]" />
                <p>No accounts in arrears</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--cf-border-subtle)]">
                {d.topArrears.map(loan => (
                  <Link key={loan.id} href={`/collections/${loan.id}`} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--cf-text)]">{borrowerDisplayName(loan)}</p>
                      <p className="text-xs text-[var(--cf-text-muted)]">{loan.reference}</p>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2 text-right">
                      <div>
                        <StatusPill tone={dpdTone(loan.daysInArrears)}>{loan.daysInArrears} DPD</StatusPill>
                        <p className="mt-1 text-xs font-semibold tabular-nums text-[var(--cf-text-muted)]">{fmt(arrearsWithCharges(loan, d.chargesLive))}</p>
                      </div>
                      <ArrowRight className="h-4 w-4 text-[var(--cf-text-muted)]" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </DataPanel>

          <DataPanel
            title="My tasks"
            description="Open tasks assigned to you."
            actions={<StatusPill tone={myTasks.length > 0 ? "info" : "success"}>{myTasks.length}</StatusPill>}
          >
            {myTasks.length === 0 ? (
              <div className="py-6 text-center text-sm text-[var(--cf-text-muted)]">
                <CheckCircle className="mx-auto mb-2 h-6 w-6 text-[var(--cf-success)]" />
                <p>No open tasks</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--cf-border-subtle)]">
                {myTasks.map(task => (
                  <div key={task.id} className="flex items-start gap-3 py-3">
                    <span className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${taskTone(task.priority)}`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[var(--cf-text)]">{task.title}</p>
                      <p className="text-xs text-[var(--cf-text-muted)]">{task.type} - {task.status}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DataPanel>

          <DataPanel title="Quick actions" description="Common operational shortcuts." variant="subtle">
            <div className="grid grid-cols-2 gap-2">
              {[
                { href: "/applications/new", icon: Plus, label: "New application" },
                { href: "/clients", icon: Users, label: "Clients" },
                { href: "/collections", icon: AlertTriangle, label: "Collections" },
                { href: "/reports", icon: BarChart3, label: "Reports" },
                { href: "/payments", icon: DollarSign, label: "Payments" },
                { href: "/disbursements", icon: TrendingUp, label: "Disburse" },
              ].map(action => (
                <Button key={action.href} asChild variant="outline" className="justify-start">
                  <Link href={action.href}><action.icon className="h-4 w-4" />{action.label}</Link>
                </Button>
              ))}
            </div>
          </DataPanel>

          <DataPanel title="NCR compliance" description="Snapshot for regulatory monitoring." variant="default">
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-[var(--cf-text-muted)]">Collectible book</span>
                <span className="font-bold tabular-nums text-[var(--cf-text)]">{fmt(d.bookValue)}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-[var(--cf-text-muted)]">PAR 30+</span>
                <StatusPill tone={d.par.par30.count > 0 ? "warning" : "neutral"}>{d.par.par30.pct.toFixed(1)}% · {d.par.par30.count} accounts</StatusPill>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-[var(--cf-text-muted)]">NPL (PAR 90+)</span>
                <StatusPill tone={d.par.par90.count > 0 ? "danger" : "neutral"}>{d.par.par90.pct.toFixed(1)}% · {d.par.par90.count} accounts</StatusPill>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-[var(--cf-text-muted)]">Write-offs (QTR)</span>
                <StatusPill tone={d.writeOffsQtr > 0 ? "danger" : "neutral"}>{d.writeOffsQtr}</StatusPill>
              </div>
              <Button asChild variant="outline" size="sm" className="mt-2 w-full">
                <Link href="/compliance/ncr-return">NCR return</Link>
              </Button>
            </div>
          </DataPanel>
        </div>
      </div>
    </div>
  )
}
