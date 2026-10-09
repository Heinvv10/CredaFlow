import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { CrossSellType, OpportunityStatus } from "@prisma/client"

const VALID_CROSS_SELL_TYPE = new Set<string>(Object.values(CrossSellType))
const VALID_OPPORTUNITY_STATUS = new Set<string>(Object.values(OpportunityStatus))

export async function GET(req: Request) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const { searchParams } = new URL(req.url)
      const type = searchParams.get("type")
      const status = searchParams.get("status")

      if (type && !VALID_CROSS_SELL_TYPE.has(type)) {
        return NextResponse.json({ error: "Invalid type filter" }, { status: 400 })
      }
      if (status && !VALID_OPPORTUNITY_STATUS.has(status)) {
        return NextResponse.json({ error: "Invalid status filter" }, { status: 400 })
      }

      const opportunities = await prisma.crossSellOpportunity.findMany({
        where: {
          tenantId: tenant.id,
          ...(type ? { type: type as CrossSellType } : {}),
          ...(status ? { status: status as OpportunityStatus } : {}),
        },
        orderBy: { createdAt: "desc" },
      })

      return NextResponse.json(opportunities)
    } catch {
      return NextResponse.json({ error: "Failed to fetch opportunities" }, { status: 500 })
    }
  })
}

export async function POST(req: Request) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const data = await req.json()

      const client = await prisma.client.findFirst({
        where: { id: data.clientId, tenantId: tenant.id },
        select: { id: true },
      })
      if (!client) {
        return NextResponse.json({ error: "Client not found" }, { status: 404 })
      }

      const opportunity = await prisma.crossSellOpportunity.create({
        data: {
          tenantId: tenant.id,
          clientId: data.clientId,
          type: data.type,
          status: "PENDING",
          assignedToId: data.assignedToId || null,
          notes: data.notes || null,
        },
      })

      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "CROSS_SELL_OPPORTUNITY_CREATED",
        entity: "CrossSellOpportunity",
        entityId: opportunity.id,
        newValue: {
          clientId: opportunity.clientId,
          type: opportunity.type,
          status: opportunity.status,
          assignedToId: opportunity.assignedToId,
        },
      })

      return NextResponse.json(opportunity, { status: 201 })
    } catch {
      return NextResponse.json({ error: "Failed to create opportunity" }, { status: 500 })
    }
  })
}
