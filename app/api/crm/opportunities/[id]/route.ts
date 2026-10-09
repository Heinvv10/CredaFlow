import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { Prisma } from "@prisma/client"

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const { id } = await params
      const data = await req.json()

      const existing = await prisma.crossSellOpportunity.findFirst({
        where: { id, tenantId: tenant.id },
        select: { status: true, assignedToId: true },
      })
      if (!existing) {
        return NextResponse.json({ error: "Opportunity not found" }, { status: 404 })
      }

      const opportunity = await prisma.crossSellOpportunity.update({
        where: { id, tenantId: tenant.id },
        data: {
          ...(data.status !== undefined && { status: data.status }),
          ...(data.assignedToId !== undefined && { assignedToId: data.assignedToId }),
          ...(data.notes !== undefined && { notes: data.notes }),
        },
      })

      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "CROSS_SELL_OPPORTUNITY_UPDATED",
        entity: "CrossSellOpportunity",
        entityId: id,
        oldValue: { status: existing.status, assignedToId: existing.assignedToId },
        newValue: { status: opportunity.status, assignedToId: opportunity.assignedToId },
      })

      return NextResponse.json(opportunity)
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json({ error: "Opportunity not found" }, { status: 404 })
      }
      return NextResponse.json({ error: "Failed to update opportunity" }, { status: 500 })
    }
  })
}
