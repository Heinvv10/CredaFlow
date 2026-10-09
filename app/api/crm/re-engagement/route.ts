import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(req: Request) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

      const leads = await prisma.lead.findMany({
        where: {
          tenantId: tenant.id,
          status: "LOST",
          updatedAt: { lt: cutoff },
          lostReason: {
            in: ["TOO_EXPENSIVE", "WENT_ELSEWHERE", "PRODUCT_MISMATCH"],
          },
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          source: true,
          lostReason: true,
          requestedAmount: true,
          declaredIncome: true,
          updatedAt: true,
          createdAt: true,
        },
        orderBy: { updatedAt: "desc" },
      })

      return NextResponse.json({
        count: leads.length,
        leads: leads.map((l) => ({
          ...l,
          daysSinceLost: Math.floor((Date.now() - new Date(l.updatedAt).getTime()) / 86400000),
        })),
      })
    } catch {
      return NextResponse.json({ error: "Failed to load re-engagement queue" }, { status: 500 })
    }
  })
}
