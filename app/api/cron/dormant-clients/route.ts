import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { OpportunityStatus } from "@prisma/client"
import { verifyCronSecret } from "@/lib/cron-auth"

const DORMANT_DAYS = 90
const ACTIVE_OPP_STATUSES: OpportunityStatus[] = ["PENDING", "CONTACTED", "INTERESTED"]

export async function POST(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - DORMANT_DAYS)

    const fallbackTenantId = await getDefaultTenantId()

    // Get all non-blacklisted clients with no active loans
    const clients = await prisma.client.findMany({
      where: {
        tenantId: fallbackTenantId,
        blacklisted: false,
        // A re-engagement opportunity against a deceased client would put
        // "win this person back" in front of staff. It creates a CRM row
        // rather than sending anything, so no message reaches the estate.
        deceasedAt: null,
        loans: {
          none: { status: "ACTIVE" },
        },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        crossSellOpportunities: {
          where: { status: { in: ACTIVE_OPP_STATUSES }, type: "PERSONAL_LOAN" },
          select: { id: true },
        },
      },
    })

    let processed = 0
    let flagged = 0

    for (const client of clients) {
      processed++

      // Check if any CrmActivity exists in the last 90 days for this client
      const recentActivity = await prisma.crmActivity.findFirst({
        where: {
          clientId: client.id,
          createdAt: { gte: cutoff },
        },
        select: { id: true },
      })

      if (recentActivity) continue

      // Client is dormant — skip if already has a pending re-engagement opportunity
      if (client.crossSellOpportunities.length > 0) continue

      await prisma.crossSellOpportunity.create({
        data: {
          tenantId: fallbackTenantId,
          clientId: client.id,
          type: "PERSONAL_LOAN",
          status: "PENDING",
          notes: `Re-engagement: client has had no activity for ${DORMANT_DAYS}+ days and has no active loans. Consider reaching out with a relevant loan offer.`,
        },
      })
      flagged++
    }

    return NextResponse.json({ ok: true, processed, flagged })
  } catch (error) {
    console.error("Dormant clients cron failed:", error)
    return NextResponse.json({ error: "Cron job failed" }, { status: 500 })
  }
}
