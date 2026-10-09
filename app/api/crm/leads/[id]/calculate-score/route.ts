import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { calculateLeadScore } from "@/lib/lead-scoring"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const { id } = await params

      const lead = await prisma.lead.findUnique({
        where: { id, tenantId: tenant.id },
        include: { activities: { select: { id: true } } },
      })

      if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 })

      const score = calculateLeadScore({
        ...lead,
        _count: { activities: lead.activities.length },
      })

      const updated = await prisma.lead.update({
        where: { id, tenantId: tenant.id },
        data: { leadScore: score, scoreCalculatedAt: new Date() },
      })

      return NextResponse.json({ score: updated.leadScore, calculatedAt: updated.scoreCalculatedAt })
    } catch {
      return NextResponse.json({ error: "Failed to calculate score" }, { status: 500 })
    }
  })
}
