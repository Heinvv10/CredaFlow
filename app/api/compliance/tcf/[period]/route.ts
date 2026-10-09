import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { logAudit } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ period: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const { period } = await params
      const decodedPeriod = decodeURIComponent(period)

      const outcome = await prisma.tcfOutcome.findUnique({
        where: { tenantId_period: { tenantId: tenant.id, period: decodedPeriod } },
      })
      if (!outcome) return NextResponse.json({ error: "Not found" }, { status: 404 })

      return NextResponse.json(outcome)
    } catch {
      return NextResponse.json({ error: "Failed to get TCF outcome" }, { status: 500 })
    }
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ period: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const session = { user: guard.user }

      const { period } = await params
      const decodedPeriod = decodeURIComponent(period)
      const body = await req.json() as {
        outcome1?: boolean
        outcome2?: boolean
        outcome3?: boolean
        outcome4?: boolean
        outcome5?: boolean
        outcome6?: boolean
        notes?: string
      }

      const outcome = await prisma.tcfOutcome.update({
        where: { tenantId_period: { tenantId: tenant.id, period: decodedPeriod } },
        data: {
          ...body,
          completedBy: session.user.id,
          completedAt: new Date(),
        },
      })

      await logAudit({
        tenantId: tenant.id,
        action: "TCF_OUTCOME_UPDATED",
        entity: "TcfOutcome",
        entityId: outcome.id,
        userId: session.user.id,
        newValue: body,
      })

      return NextResponse.json(outcome)
    } catch {
      return NextResponse.json({ error: "Failed to update TCF outcome" }, { status: 500 })
    }
  })
}
