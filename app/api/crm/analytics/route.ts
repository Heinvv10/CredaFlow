import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { leadConversionState, leadPipelineStatus } from "@/lib/crm/lead-conversion"
import { sastMonthBounds } from "@/lib/compliance/quarters"

const STATUS_ORDER = ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL_SENT", "INCOMPLETE", "STRANDED", "CONVERTED", "LOST"] as const

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const now = new Date()
      // SAST boundary: local date parts resolve in UTC on this container.
      const monthStart = sastMonthBounds(now).start
      const staleThreshold = new Date(Date.now() - 48 * 60 * 60 * 1000)

      const reEngageableCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

      const leads = await prisma.lead.findMany({
        where: { tenantId: tenant.id },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          status: true,
          source: true,
          lostReason: true,
          requestedAmount: true,
          createdAt: true,
          updatedAt: true,
          statusChangedAt: true,
          convertedToClientId: true,
          convertedToApplicationId: true,
          conversionRecoveryRequired: true,
        },
      })

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

      // Funnel: count per status with percentage
      const funnelCounts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<string, number>
      for (const l of leads) {
        const displayStatus = pipelineStatus(l)
        if (funnelCounts[displayStatus] !== undefined) funnelCounts[displayStatus]++
      }
      const funnel = STATUS_ORDER.map((status) => ({
        status,
        count: funnelCounts[status],
        pct: total > 0 ? Math.round((funnelCounts[status] / total) * 100) : 0,
      }))

      // By source: total, converted, conversion rate
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

      // Stale leads: updatedAt < 48h ago, not CONVERTED/LOST
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

      // This month: new, converted, lost
      const monthLeads = leads.filter((l) => new Date(l.createdAt) >= monthStart)
      const thisMonth = {
        newLeads: monthLeads.length,
        converted: completedLeads.filter(
          (l) => new Date(l.statusChangedAt) >= monthStart,
        ).length,
        lost: leads.filter(
          (l) => l.status === "LOST" && new Date(l.updatedAt) >= monthStart,
        ).length,
      }

      // Revenue belongs to the exact conversion application, never every
      // application owned by the linked client.
      const convertedApplicationIds = completedLeads.map(
        (lead) => lead.convertedToApplicationId as string,
      )

      const revenueResult = convertedApplicationIds.length > 0
        ? await prisma.loanApplication.aggregate({
            _sum: { appliedAmount: true },
            where: { tenantId: tenant.id, id: { in: convertedApplicationIds } },
          })
        : { _sum: { appliedAmount: null } }

      // Source attribution by value: avg loan amount per converted lead per source
      const convertedLeadsWithAmount = convertedApplicationIds.length > 0
        ? await prisma.loanApplication.findMany({
            where: { tenantId: tenant.id, id: { in: convertedApplicationIds } },
            select: { id: true, appliedAmount: true },
          })
        : []

      const applicationToSource: Record<string, string> = {}
      for (const lead of completedLeads) {
        if (lead.convertedToApplicationId) {
          applicationToSource[lead.convertedToApplicationId] = lead.source
        }
      }

      const sourceValueMap: Record<string, { totalAmount: number; count: number }> = {}
      for (const app of convertedLeadsWithAmount) {
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
              (sourceValueMap[s.source].totalAmount / sourceValueMap[s.source].count) *
                (s.rate / 100)
            )
          : 0,
      }))

      // Re-engagement queue count
      const reEngagementCount = leads.filter(
        (l) =>
          l.status === "LOST" &&
          new Date(l.updatedAt) < reEngageableCutoff &&
          ["TOO_EXPENSIVE", "WENT_ELSEWHERE", "PRODUCT_MISMATCH"].includes(l.lostReason ?? ""),
      ).length

      // Lost reasons breakdown
      const lostReasonMap: Record<string, number> = {}
      for (const l of leads.filter((x) => x.status === "LOST")) {
        const r = l.lostReason ?? "UNKNOWN"
        lostReasonMap[r] = (lostReasonMap[r] ?? 0) + 1
      }
      const lostReasons = Object.entries(lostReasonMap).map(([reason, count]) => ({ reason, count }))

      return NextResponse.json({
        funnel,
        bySource: bySourceWithValue,
        staleLeads,
        thisMonth,
        revenueFromLeads: revenueResult._sum.appliedAmount ?? 0,
        reEngagementCount,
        lostReasons,
      })
    } catch {
      return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 })
    }
  })
}
