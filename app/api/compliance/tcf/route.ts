import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyRefusal } from "@/lib/jurisdiction/nca-only"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { logAudit } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const notNca = await ncaOnlyRefusal("TCF reporting")
  if (notNca) return notNca

  return withTenantContext(req, async (tenant) => {
    try {
      const outcomes = await prisma.tcfOutcome.findMany({
        where: { tenantId: tenant.id },
        orderBy: { period: "desc" },
      })

      return NextResponse.json(outcomes)
    } catch {
      return NextResponse.json({ error: "Failed to get TCF outcomes" }, { status: 500 })
    }
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const notNca = await ncaOnlyRefusal("TCF reporting")
  if (notNca) return notNca

  return withTenantContext(req, async (tenant) => {
    try {
      const body = await req.json() as {
        period: string
        outcome1?: boolean
        outcome2?: boolean
        outcome3?: boolean
        outcome4?: boolean
        outcome5?: boolean
        outcome6?: boolean
        notes?: string
      }

      if (!body.period) return NextResponse.json({ error: "Period is required" }, { status: 400 })

      const data = {
        outcome1: body.outcome1 ?? false,
        outcome2: body.outcome2 ?? false,
        outcome3: body.outcome3 ?? false,
        outcome4: body.outcome4 ?? false,
        outcome5: body.outcome5 ?? false,
        outcome6: body.outcome6 ?? false,
        notes: body.notes ?? null,
        completedBy: guard.user.id,
        completedAt: new Date(),
      }

      const outcome = await prisma.tcfOutcome.upsert({
        where: { tenantId_period: { tenantId: tenant.id, period: body.period } },
        create: { tenantId: tenant.id, period: body.period, ...data },
        update: data,
      })

      await logAudit({
        tenantId: tenant.id,
        action: "TCF_OUTCOME_UPSERTED",
        entity: "TcfOutcome",
        entityId: outcome.id,
        userId: guard.user.id,
        newValue: { period: body.period },
      })

      return NextResponse.json(outcome)
    } catch {
      return NextResponse.json({ error: "Failed to save TCF outcome" }, { status: 500 })
    }
  })
}
