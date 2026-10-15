import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { OpportunityStatus } from "@prisma/client"
import { verifyCronSecret } from "@/lib/cron-auth"

const DORMANT_DAYS = 90
const ACTIVE_OPP_STATUSES: OpportunityStatus[] = ["PENDING", "CONTACTED", "INTERESTED"]

async function sweepTenant(tenantId: string, cutoff: Date): Promise<{ processed: number; flagged: number }> {
  // Get all non-blacklisted clients with no active loans
  const clients = await prisma.client.findMany({
    where: {
      tenantId,
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
        tenantId,
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
        tenantId,
        clientId: client.id,
        type: "PERSONAL_LOAN",
        status: "PENDING",
        notes: `Re-engagement: client has had no activity for ${DORMANT_DAYS}+ days and has no active loans. Consider reaching out with a relevant loan offer.`,
      },
    })
    flagged++
  }

  return { processed, flagged }
}

/**
 * Weekly: sweeps every ACTIVE tenant, each inside its own frame. Any failed tenant
 * makes the response 503: the scheduler treats only a non-2xx as a failure,
 * and never reads the body.
 */
export async function POST(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - DORMANT_DAYS)

    const tenants = await prisma.tenant.findMany({ where: { status: "ACTIVE" }, select: { id: true }, orderBy: { id: "asc" } })
    const perTenant: Array<{ tenantId: string; processed: number; flagged: number } | { tenantId: string; error: string }> = []
    let processed = 0
    let flagged = 0
    for (const { id: tenantId } of tenants) {
      try {
        const result = await runWithTenant(tenantId, () => sweepTenant(tenantId, cutoff))
        processed += result.processed
        flagged += result.flagged
        perTenant.push({ tenantId, ...result })
      } catch (error) {
        console.error(`[cron/dormant-clients] tenant ${tenantId} failed:`, error)
        perTenant.push({ tenantId, error: error instanceof Error ? error.message : String(error) })
      }
    }

    const ok = perTenant.every((t) => !("error" in t))
    return NextResponse.json({ ok, processed, flagged, perTenant }, { status: ok ? 200 : 503 })
  } catch (error) {
    console.error("[cron/dormant-clients] failed:", error)
    return NextResponse.json({ error: "Cron job failed" }, { status: 500 })
  }
}
