import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { logAudit } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"
import type { ClientRiskLevel } from "@prisma/client"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const { id } = await params
      const body = await req.json() as { riskLevel?: ClientRiskLevel; note?: string }

      if (!body.riskLevel) {
        return NextResponse.json({ error: "riskLevel is required" }, { status: 400 })
      }

      const validLevels: ClientRiskLevel[] = ["NORMAL", "WATCH", "HIGH_RISK", "DELINQUENT"]
      if (!validLevels.includes(body.riskLevel)) {
        return NextResponse.json({ error: "Invalid riskLevel" }, { status: 400 })
      }

      const existing = await prisma.client.findUnique({ where: { id, tenantId: tenant.id }, select: { riskLevel: true } })
      if (!existing) {
        return NextResponse.json({ error: "Client not found" }, { status: 404 })
      }

      const updated = await prisma.client.update({
        where: { id, tenantId: tenant.id },
        data: {
          riskLevel: body.riskLevel,
          riskFlagNote: body.note ?? null,
          riskFlaggedAt: new Date(),
          riskFlaggedById: guard.user.id,
        },
        select: {
          id: true,
          riskLevel: true,
          riskFlagNote: true,
          riskFlaggedAt: true,
          riskFlaggedById: true,
        },
      })

      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "CLIENT_RISK_FLAGGED",
        entity: "Client",
        entityId: id,
        oldValue: { riskLevel: existing.riskLevel },
        newValue: { riskLevel: body.riskLevel, note: body.note },
      })

      return NextResponse.json(updated)
    })
  } catch (error) {
    console.error("Failed to update client risk level:", error)
    return NextResponse.json({ error: "Failed to update risk level" }, { status: 500 })
  }
}
