import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const { id } = await params
      const log = await prisma.breachLog.findFirst({ where: { id, tenantId: tenant.id } })
      if (!log) return NextResponse.json({ error: "Breach log not found" }, { status: 404 })

      return NextResponse.json(log)
    } catch {
      return NextResponse.json({ error: "Failed to fetch breach log" }, { status: 500 })
    }
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { user } = guard

  return withTenantContext(req, async (tenant) => {
    try {
      const { id } = await params
      const existing = await prisma.breachLog.findFirst({
        where: { id, tenantId: tenant.id },
        select: { status: true, containmentAction: true, reportedToIC: true, reportedAt: true },
      })
      if (!existing) return NextResponse.json({ error: "Breach log not found" }, { status: 404 })

      const body = await req.json() as {
        status?: string
        containmentAction?: string
        reportedToIC?: boolean
        reportedAt?: string
      }

      const data = {
        ...(body.status && { status: body.status }),
        ...(body.containmentAction !== undefined && { containmentAction: body.containmentAction }),
        ...(body.reportedToIC !== undefined && { reportedToIC: body.reportedToIC }),
        ...(body.reportedAt !== undefined && { reportedAt: body.reportedAt ? new Date(body.reportedAt) : null }),
      }
      const changed = Object.keys(data) as Array<keyof typeof existing>

      // The edit and its audit row commit together: the row keeps no history,
      // so the values it replaces survive only in the audit row.
      const log = await prisma.$transaction(async (tx) => {
        const updated = await tx.breachLog.update({ where: { id, tenantId: tenant.id }, data })
        await logAuditStrict({
          tenantId: tenant.id,
          userId: user.id,
          userEmail: user.email,
          action: AuditAction.BREACH_LOG_UPDATED,
          entity: "BreachLog",
          entityId: id,
          oldValue: Object.fromEntries(changed.map((field) => [field, existing[field]])),
          newValue: Object.fromEntries(changed.map((field) => [field, updated[field]])),
        }, tx)
        return updated
      })

      return NextResponse.json(log)
    } catch {
      return NextResponse.json({ error: "Failed to update breach log" }, { status: 500 })
    }
  })
}
