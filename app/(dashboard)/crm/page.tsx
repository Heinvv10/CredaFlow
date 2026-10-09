import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { CrmDashboardClient } from "@/components/crm/CrmDashboardClient"
import { leadConversionState, leadPipelineStatus } from "@/lib/crm/lead-conversion"

const STATUS_ORDER = ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL_SENT", "INCOMPLETE", "STRANDED", "CONVERTED", "LOST"] as const
import { sastMonthBounds } from "@/lib/compliance/quarters"
import { sastStartOfDay } from "@/lib/date/sast"

async function getCrmData(tenantId: string) {
  const now = new Date()
  // SAST boundary: the container has no TZ, so date parts resolve in UTC and
  // land two hours inside the previous South African day.
  const monthStart = sastMonthBounds(now).start
  const staleThreshold = new Date(Date.now() - 48 * 60 * 60 * 1000)
  // `setHours(0,0,0,0)` is local midnight too. End-exclusive, so a callback
  // booked in the last two hours of the SAST day is still due today.
  const todayStart = sastStartOfDay(now)
  const todayEndExclusive = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)
  const reEngageableCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

  const [leads, crossSellCount, recentActivities, callbacksDueToday, agents] = await Promise.all([
    prisma.lead.findMany({
      where: { tenantId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        status: true,
        source: true,
        lostReason: true,
        createdAt: true,
        updatedAt: true,
        statusChangedAt: true,
        convertedToClientId: true,
        convertedToApplicationId: true,
        conversionRecoveryRequired: true,
        assignedToId: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.crossSellOpportunity.count({ where: { tenantId, status: { not: "CONVERTED" } } }),
    prisma.crmActivity.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.lead.findMany({
      where: {
        tenantId,
        callbackDate: { gte: todayStart, lt: todayEndExclusive },
        status: { notIn: ["CONVERTED", "LOST"] },
      },
      select: { id: true, firstName: true, lastName: true, callbackDate: true, callbackNotes: true },
      orderBy: { callbackDate: "asc" },
    }),
    prisma.user.findMany({
      where: { tenantId, active: true, role: { in: ["CREDIT_OFFICER", "LOAN_ADMIN", "COLLECTIONS_OFFICER"] } },
      select: { id: true, name: true },
    }),
  ])

  const rawOpportunities = await prisma.crossSellOpportunity.findMany({
    where: { tenantId, status: { in: ["PENDING", "CONTACTED", "INTERESTED"] } },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: {
      id: true,
      type: true,
      status: true,
      createdAt: true,
      client: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          loans: {
            where: { status: "ACTIVE" },
            select: { outstandingPrincipal: true },
            orderBy: { outstandingPrincipal: "desc" },
            take: 1,
          },
        },
      },
    },
  })
  const topOpportunities = [...rawOpportunities]
    .sort((a, b) => (b.client.loans[0]?.outstandingPrincipal ?? 0) - (a.client.loans[0]?.outstandingPrincipal ?? 0))
    .slice(0, 5)
    .map((opp) => ({
      ...opp,
      daysOpen: Math.floor((now.getTime() - opp.createdAt.getTime()) / 86400000),
    }))

  const total = leads.length
  const conversionState = (lead: (typeof leads)[number]) => leadConversionState(
    lead.status,
    lead.convertedToClientId,
    lead.convertedToApplicationId,
    lead.conversionRecoveryRequired,
  )
  const pipelineStatus = (lead: (typeof leads)[number]) => leadPipelineStatus(
    lead.status,
    lead.convertedToClientId,
    lead.convertedToApplicationId,
    lead.conversionRecoveryRequired,
  )
  const completedLeads = leads.filter((lead) => conversionState(lead) === "COMPLETE")

  // KPI stats
  const convertedThisMonth = completedLeads.filter(
    (lead) => new Date(lead.statusChangedAt) >= monthStart,
  ).length

  // Funnel
  const funnelCounts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<string, number>
  for (const l of leads) {
    const displayStatus = pipelineStatus(l)
    if (funnelCounts[displayStatus] !== undefined) funnelCounts[displayStatus]++
  }
  // Avg time-in-stage per status
  const stageAvgDays: Record<string, number> = {}
  for (const status of STATUS_ORDER) {
    const statusLeads = leads.filter((l) => pipelineStatus(l) === status)
    if (statusLeads.length === 0) continue
    if (status === "CONVERTED") {
      stageAvgDays[status] = Math.round(
        statusLeads.reduce((sum, l) => sum + (new Date(l.statusChangedAt).getTime() - new Date(l.createdAt).getTime()), 0) /
          statusLeads.length / 86400000
      )
    } else {
      stageAvgDays[status] = Math.round(
        statusLeads.reduce((sum, l) => sum + (Date.now() - new Date(l.updatedAt).getTime()), 0) /
          statusLeads.length / 86400000
      )
    }
  }

  const funnelData = STATUS_ORDER.map((status) => ({
    status,
    count: funnelCounts[status],
    pct: total > 0 ? Math.round((funnelCounts[status] / total) * 100) : 0,
    avgDays: stageAvgDays[status] ?? 0,
  }))

  // By source
  const sourceMap: Record<string, { total: number; converted: number }> = {}
  for (const l of leads) {
    if (!sourceMap[l.source]) sourceMap[l.source] = { total: 0, converted: 0 }
    sourceMap[l.source].total++
    if (conversionState(l) === "COMPLETE") sourceMap[l.source].converted++
  }
  const bySource = Object.entries(sourceMap).map(([source, { total: t, converted: c }]) => ({
    source,
    total: t,
    converted: c,
    rate: t > 0 ? Math.round((c / t) * 100) : 0,
  }))

  // Lost reasons
  const lostReasonMap: Record<string, number> = {}
  for (const l of leads.filter((x) => x.status === "LOST")) {
    const r = l.lostReason ?? "UNKNOWN"
    lostReasonMap[r] = (lostReasonMap[r] ?? 0) + 1
  }
  const lostReasons = Object.entries(lostReasonMap).map(([reason, count]) => ({ reason, count }))

  // Revenue belongs to the exact application created by the conversion. Never
  // infer it from every application owned by the client: repeat borrowers and
  // incomplete legacy links would inflate conversion value.
  const allConvertedApplicationIds = completedLeads.map(
    (lead) => lead.convertedToApplicationId as string,
  )
  const thisMonthConvertedApplicationIds = completedLeads
    .filter((lead) => new Date(lead.statusChangedAt) >= monthStart)
    .map((lead) => lead.convertedToApplicationId as string)

  const [revenueResult, convertedApps] = await Promise.all([
    thisMonthConvertedApplicationIds.length > 0
      ? prisma.loanApplication.aggregate({
          _sum: { appliedAmount: true },
          where: { tenantId, id: { in: thisMonthConvertedApplicationIds } },
        })
      : Promise.resolve({ _sum: { appliedAmount: null } }),
    allConvertedApplicationIds.length > 0
      ? prisma.loanApplication.findMany({
          where: { tenantId, id: { in: allConvertedApplicationIds } },
          select: { id: true, appliedAmount: true },
        })
      : Promise.resolve([]),
  ])

  const applicationToSource: Record<string, string> = {}
  for (const lead of completedLeads) {
    if (lead.convertedToApplicationId) {
      applicationToSource[lead.convertedToApplicationId] = lead.source
    }
  }

  const sourceValueMap: Record<string, { totalAmount: number; count: number }> = {}
  for (const app of convertedApps) {
    const src = applicationToSource[app.id] ?? "UNKNOWN"
    if (!sourceValueMap[src]) sourceValueMap[src] = { totalAmount: 0, count: 0 }
    sourceValueMap[src].totalAmount += app.appliedAmount
    sourceValueMap[src].count++
  }

  const bySourceWithValue = bySource.map((s) => ({
    ...s,
    avgLoanAmount: sourceValueMap[s.source]?.count
      ? Math.round(sourceValueMap[s.source].totalAmount / sourceValueMap[s.source].count)
      : 0,
    expectedRevenuePerLead: s.total > 0 && sourceValueMap[s.source]
      ? Math.round(
          (sourceValueMap[s.source].totalAmount / sourceValueMap[s.source].count) * (s.rate / 100)
        )
      : 0,
  }))

  // Re-engagement count
  const reEngagementCount = leads.filter(
    (l) =>
      l.status === "LOST" &&
      new Date(l.updatedAt) < reEngageableCutoff &&
      ["TOO_EXPENSIVE", "WENT_ELSEWHERE", "PRODUCT_MISMATCH"].includes(l.lostReason ?? ""),
  ).length

  // Stale leads
  const staleLeads = leads
    .filter(
      (l) =>
        !["CONVERTED", "LOST"].includes(pipelineStatus(l)) &&
        new Date(l.updatedAt) < staleThreshold,
    )
    .map((l) => ({
      id: l.id,
      firstName: l.firstName,
      lastName: l.lastName,
      status: pipelineStatus(l),
      daysSinceUpdate: Math.floor(
        (Date.now() - new Date(l.updatedAt).getTime()) / 86400000,
      ),
    }))

  const topLeads = leads.slice(0, 5).map((lead) => ({
    ...lead,
    status: pipelineStatus(lead),
  }))

  // Agent performance stats
  const agentPerf = agents.map((agent) => {
    const agentLeads = leads.filter((l) => l.assignedToId === agent.id)
    const active = agentLeads.filter((l) => !["CONVERTED", "LOST"].includes(pipelineStatus(l)))
    const convertedThisMonthByAgent = agentLeads.filter(
      (l) => conversionState(l) === "COMPLETE" && new Date(l.statusChangedAt) >= monthStart,
    )
    const convertedAll = agentLeads.filter((l) => conversionState(l) === "COMPLETE")
    const oldestUnactioned = [...active].sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())[0]
    const avgConvertDays = convertedAll.length > 0
      ? Math.round(convertedAll.reduce((sum, l) => sum + Math.floor((new Date(l.statusChangedAt).getTime() - new Date(l.createdAt).getTime()) / 86400000), 0) / convertedAll.length)
      : 0

    return {
      id: agent.id,
      name: agent.name ?? "—",
      activePipeline: active.length,
      convertedThisMonth: convertedThisMonthByAgent.length,
      avgConvertDays,
      oldestUnactionedDays: oldestUnactioned
        ? Math.floor((Date.now() - new Date(oldestUnactioned.updatedAt).getTime()) / 86400000)
        : 0,
    }
  }).filter((a) => a.activePipeline > 0 || a.convertedThisMonth > 0)

  return {
    totalLeads: total,
    convertedThisMonth,
    crossSellCount,
    recentActivities,
    topLeads,
    funnelData,
    bySource: bySourceWithValue,
    staleLeads,
    callbacksDueToday,
    reEngagementCount,
    lostReasons,
    agentPerf,
    revenueFromLeads: Number(revenueResult._sum.appliedAmount ?? 0),
    topOpportunities,
  }
}

export default async function CrmPage() {
  const tenantId = await getDefaultTenantId()
  const data = await getCrmData(tenantId)

  return (
    <div className="p-6 lg:p-8">
      <CrmDashboardClient {...data} />
    </div>
  )
}
